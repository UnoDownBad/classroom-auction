const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const setupDatabase = require('./database');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    maxHttpBufferSize: 1e7
});

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

let db;

// Strict Course, Year Level, & Section Validation
const ALLOWED_COURSES = ['BSIT', 'BSHM', 'BSBA', 'BSED', 'BEED'];
const ALLOWED_YEARS = ['1ST YEAR', '2ND YEAR', '3RD YEAR', '4TH YEAR', '1ST', '2ND', '3RD', '4TH', '1', '2', '3', '4'];
const ALLOWED_SECTIONS = ['A', 'B', 'C', 'D', 'E'];

function validateCourseSectionYear(sectionStr) {
    if (!sectionStr) return false;
    const upper = sectionStr.trim().toUpperCase();
    
    const hasCourse = ALLOWED_COURSES.some(c => upper.includes(c));
    const hasYear = ALLOWED_YEARS.some(y => upper.includes(y));
    const hasSection = ALLOWED_SECTIONS.some(s => new RegExp(`(^|[-_\\s\\d])${s}($|[-_\\s\\d])`).test(upper));

    return hasCourse && hasYear && hasSection;
}

function getTeacherSections(user) {
    if (user.role === 'teacher') {
        try {
            return JSON.parse(user.sections || '[]');
        } catch (e) {
            return user.sections ? [user.sections] : [];
        }
    }
    return user.section ? [user.section] : [];
}

io.on('connection', (socket) => {

    const broadcastUpdates = async (section) => {
        if (!section) return;

        const users = await db.all('SELECT id, name, section, avatar, role, coin_balance, status, created_at FROM Users WHERE section = ? AND (status IS NULL OR status = "active")', [section]);
        const archivedUsers = await db.all('SELECT id, name, section, avatar, role, coin_balance, status FROM Users WHERE section = ? AND status = "archived" AND role = "student"', [section]);
        
        const perks = await db.all('SELECT * FROM Perks WHERE section = ? AND status = "active" ORDER BY id DESC', [section]);
        const winnerHistory = await db.all('SELECT * FROM Perks WHERE section = ? AND status = "closed" ORDER BY ends_at DESC', [section]);
        
        const totalCoins = await db.get('SELECT SUM(coin_balance) as sum FROM Users WHERE role = "student" AND section = ? AND (status IS NULL OR status = "active")', [section]);
        const activeAuctions = await db.get('SELECT COUNT(*) as count FROM Perks WHERE status = "active" AND section = ?', [section]);
        const totalBids = await db.get('SELECT COUNT(*) as count FROM Bids JOIN Perks ON Bids.perk_id = Perks.id WHERE Perks.section = ?', [section]);

        const analytics = {
            totalCoinsInCirculation: totalCoins ? (totalCoins.sum || 0) : 0,
            activeAuctions: activeAuctions ? (activeAuctions.count || 0) : 0,
            totalBidsPlaced: totalBids ? (totalBids.count || 0) : 0
        };

        io.to(section).emit('state_update', { section, users, archivedUsers, perks, winnerHistory, analytics });
    };

    socket.on('update_name', async ({ userId, newName, section }) => {
        const trimmedName = newName ? newName.trim() : '';
        if (!userId || !trimmedName) {
            return socket.emit('profile_error', 'Name cannot be left empty.');
        }

        const existing = await db.get('SELECT id FROM Users WHERE LOWER(name) = LOWER(?) AND id != ?', [trimmedName, userId]);
        if (existing) {
            return socket.emit('profile_error', 'That name is already taken by another user.');
        }

        await db.run('UPDATE Users SET name = ? WHERE id = ?', [trimmedName, userId]);
        socket.emit('name_updated', { name: trimmedName });
        broadcastUpdates(section);
    });

    socket.on('update_avatar', async ({ userId, avatarUrl, section }) => {
        if (!userId || !avatarUrl) return;
        await db.run('UPDATE Users SET avatar = ? WHERE id = ?', [avatarUrl.trim(), userId]);
        const updatedUser = await db.get('SELECT id, name, section, avatar, role, coin_balance FROM Users WHERE id = ?', [userId]);
        socket.emit('avatar_updated', { avatar: updatedUser.avatar });
        broadcastUpdates(section);
    });

    socket.on('login_student', async ({ name, password }) => {
        const trimmedName = name ? name.trim() : '';
        if (!trimmedName || !password) return socket.emit('login_error', 'Please fill in all fields.');

        const user = await db.get('SELECT * FROM Users WHERE LOWER(name) = LOWER(?)', [trimmedName]);
        if (!user) return socket.emit('login_error', 'Student account not found! Please sign up first.');

        if (user.role !== 'student') {
            return socket.emit('login_error', 'Access denied. Use the Teacher portal.');
        }

        if (user.status === 'archived') {
            return socket.emit('login_error', 'Your account has been archived by the teacher.');
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) return socket.emit('login_error', 'Incorrect password.');

        socket.join(user.section);

        await db.run('INSERT INTO Logins (user_id) VALUES (?)', [user.id]);
        const history = await db.all('SELECT * FROM TransactionHistory WHERE user_id = ? ORDER BY timestamp DESC', [user.id]);

        const avatar = user.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.name)}`;

        socket.emit('login_success', {
            user: { id: user.id, name: user.name, section: user.section, avatar, role: user.role, coin_balance: user.coin_balance },
            history
        });
        broadcastUpdates(user.section);
    });

    socket.on('signup_student', async ({ name, section, avatar, password }) => {
        const trimmedName = name ? name.trim() : '';
        const trimmedSection = section ? section.trim() : '';
        const defaultAvatar = avatar ? avatar.trim() : `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(trimmedName)}`;

        if (!trimmedName || !trimmedSection || !password) {
            return socket.emit('signup_error', 'Please fill in all fields including section.');
        }
        if (password.length < 4) {
            return socket.emit('signup_error', 'Password must be at least 4 characters.');
        }

        if (!validateCourseSectionYear(trimmedSection)) {
            return socket.emit('signup_error', 'Invalid selection! Allowed courses: BSIT, BSHM, BSBA, BSED, BEED. Allowed years: 1st, 2nd, 3rd, 4th Year. Allowed sections: A, B, C, D, E.');
        }

        const existingUser = await db.get('SELECT * FROM Users WHERE LOWER(name) = LOWER(?)', [trimmedName]);
        if (existingUser) return socket.emit('signup_error', 'Account name already exists. Please log in.');

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.run(
            'INSERT INTO Users (name, section, avatar, password, role, coin_balance, status) VALUES (?, ?, ?, ?, "student", 100, "active")',
            [trimmedName, trimmedSection, defaultAvatar, hashedPassword]
        );

        const newUser = await db.get('SELECT id, name, section, avatar, role, coin_balance FROM Users WHERE id = ?', [result.lastID]);
        
        socket.join(newUser.section);

        await db.run('INSERT INTO TransactionHistory (user_id, amount, type, reason) VALUES (?, 100, "earned", "Welcome Bonus")', [newUser.id]);
        await db.run('INSERT INTO Logins (user_id) VALUES (?)', [newUser.id]);

        const history = await db.all('SELECT * FROM TransactionHistory WHERE user_id = ? ORDER BY timestamp DESC', [newUser.id]);

        socket.emit('login_success', { user: newUser, history });
        broadcastUpdates(newUser.section);
    });

    socket.on('login_teacher', async ({ name, password }) => {
        const trimmedName = name ? name.trim() : '';
        if (!trimmedName || !password) return socket.emit('login_error', 'Please enter your teacher name and password.');

        const user = await db.get('SELECT * FROM Users WHERE LOWER(name) = LOWER(?)', [trimmedName]);
        if (!user) return socket.emit('login_error', 'Teacher account not found. Please sign up first.');

        if (user.role !== 'teacher') {
            return socket.emit('login_error', 'Access denied. Student accounts cannot access the Teacher portal.');
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) return socket.emit('login_error', 'Incorrect password.');

        const teacherSections = getTeacherSections(user);
        teacherSections.forEach(sec => socket.join(sec));

        await db.run('INSERT INTO Logins (user_id) VALUES (?)', [user.id]);
        const avatar = user.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.name)}`;

        socket.emit('login_success', {
            user: { id: user.id, name: user.name, sections: teacherSections, avatar, role: user.role, coin_balance: user.coin_balance },
            logins: [],
            history: []
        });
        
        teacherSections.forEach(sec => broadcastUpdates(sec));
    });

    socket.on('signup_teacher', async ({ name, sections, avatar, password }) => {
        const trimmedName = name ? name.trim() : '';
        const defaultAvatar = avatar ? avatar.trim() : `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(trimmedName)}`;

        if (!trimmedName || !sections || !Array.isArray(sections) || sections.length === 0 || !password) {
            return socket.emit('signup_error', 'Please fill in all fields and select at least one course/section.');
        }
        if (password.length < 4) return socket.emit('signup_error', 'Password must be at least 4 characters.');

        for (const sec of sections) {
            if (!validateCourseSectionYear(sec)) {
                return socket.emit('signup_error', `Invalid selection in ${sec}! Allowed courses: BSIT, BSHM, BSBA, BSED, BEED. Allowed years: 1st, 2nd, 3rd, 4th Year. Allowed sections: A, B, C, D, E.`);
            }
        }

        const existingUser = await db.get('SELECT * FROM Users WHERE LOWER(name) = LOWER(?)', [trimmedName]);
        if (existingUser) return socket.emit('signup_error', 'Account name already taken.');

        const hashedPassword = await bcrypt.hash(password, 10);
        const sectionsJson = JSON.stringify(sections);

        const result = await db.run(
            'INSERT INTO Users (name, sections, avatar, password, role, coin_balance, status) VALUES (?, ?, ?, ?, "teacher", 0, "active")',
            [trimmedName, sectionsJson, defaultAvatar, hashedPassword]
        );

        const newUser = await db.get('SELECT id, name, sections, avatar, role, coin_balance FROM Users WHERE id = ?', [result.lastID]);
        
        sections.forEach(sec => socket.join(sec));

        await db.run('INSERT INTO Logins (user_id) VALUES (?)', [newUser.id]);

        socket.emit('login_success', {
            user: { ...newUser, sections },
            logins: [],
            history: []
        });

        sections.forEach(sec => broadcastUpdates(sec));
    });

    socket.on('archive_student', async ({ studentId, section }) => {
        if (!studentId || !section) return;
        await db.run('UPDATE Users SET status = "archived" WHERE id = ? AND role = "student" AND section = ?', [studentId, section]);
        broadcastUpdates(section);
    });

    socket.on('unarchive_student', async ({ studentId, section }) => {
        if (!studentId || !section) return;
        await db.run('UPDATE Users SET status = "active" WHERE id = ? AND role = "student" AND section = ?', [studentId, section]);
        broadcastUpdates(section);
    });

    socket.on('delete_student', async ({ studentId, section }) => {
        if (!studentId || !section) return;
        await db.run('UPDATE Users SET status = "archived" WHERE id = ? AND role = "student" AND section = ?', [studentId, section]);
        broadcastUpdates(section);
    });

    socket.on('update_coins', async ({ target, studentId, section, amount, reason }) => {
        if (target === 'all') {
            await db.run('UPDATE Users SET coin_balance = coin_balance + ? WHERE role = "student" AND section = ? AND (status IS NULL OR status = "active")', [amount, section]);
            const students = await db.all('SELECT id FROM Users WHERE role = "student" AND section = ? AND (status IS NULL OR status = "active")', [section]);
            for (const s of students) {
                await db.run('INSERT INTO TransactionHistory (user_id, amount, type, reason) VALUES (?, ?, ?, ?)', [
                    s.id, amount, amount >= 0 ? 'earned' : 'deducted', reason || 'Class-wide Award'
                ]);
            }
        } else {
            await db.run('UPDATE Users SET coin_balance = coin_balance + ? WHERE id = ? AND section = ?', [amount, studentId, section]);
            await db.run('INSERT INTO TransactionHistory (user_id, amount, type, reason) VALUES (?, ?, ?, ?)', [
                studentId, amount, amount >= 0 ? 'earned' : 'deducted', reason || 'Teacher Adjustment'
            ]);
        }
        broadcastUpdates(section);
    });

    socket.on('create_perk', async ({ title, description, section, startingBid, durationValue, durationUnit }) => {
        if (!title || !section || isNaN(startingBid) || isNaN(durationValue)) {
            return socket.emit('bid_error', 'Invalid perk details provided.');
        }
        let durationMs = durationValue * 60000;
        if (durationUnit === 'hours') durationMs = durationValue * 3600000;
        if (durationUnit === 'days') durationMs = durationValue * 86400000;

        const endsAt = new Date(Date.now() + durationMs).toISOString();

        await db.run(
            'INSERT INTO Perks (title, description, section, starting_bid, current_bid, ends_at) VALUES (?, ?, ?, ?, ?, ?)',
            [title, description, section, startingBid, startingBid, endsAt]
        );
        broadcastUpdates(section);
    });

    socket.on('place_bid', async ({ perkId, userId, bidAmount }) => {
        const perk = await db.get('SELECT * FROM Perks WHERE id = ?', [perkId]);
        const user = await db.get('SELECT * FROM Users WHERE id = ?', [userId]);

        if (!perk || perk.status !== 'active' || new Date(perk.ends_at) <= new Date()) {
            return socket.emit('bid_error', 'This auction is closed.');
        }
        if (user.section !== perk.section) {
            return socket.emit('bid_error', 'You cannot bid on auctions outside your section.');
        }
        if (bidAmount <= perk.current_bid) {
            return socket.emit('bid_error', 'Bid must be strictly higher than current bid.');
        }
        if (user.coin_balance < bidAmount) {
            return socket.emit('bid_error', 'Insufficient coins balance.');
        }

        const previousBidderId = perk.highest_bidder_id;

        if (previousBidderId) {
            await db.run('UPDATE Users SET coin_balance = coin_balance + ? WHERE id = ?', [perk.current_bid, previousBidderId]);
            await db.run('INSERT INTO TransactionHistory (user_id, amount, type, reason) VALUES (?, ?, "refund", ?)', [
                previousBidderId, perk.current_bid, `Outbid refund on "${perk.title}"`
            ]);
        }

        await db.run('UPDATE Users SET coin_balance = coin_balance - ? WHERE id = ?', [bidAmount, userId]);
        await db.run('INSERT INTO TransactionHistory (user_id, amount, type, reason) VALUES (?, ?, "spent", ?)', [
            userId, -bidAmount, `Placed highest bid on "${perk.title}"`
        ]);

        const displayName = `${user.name} (${user.section})`;
        await db.run(
            'UPDATE Perks SET current_bid = ?, highest_bidder_id = ?, highest_bidder_name = ? WHERE id = ?',
            [bidAmount, userId, displayName, perkId]
        );
        await db.run('INSERT INTO Bids (perk_id, user_id, bid_amount) VALUES (?, ?, ?)', [perkId, userId, bidAmount]);

        if (previousBidderId && previousBidderId !== userId) {
            io.to(perk.section).emit('outbid_notification', { userId: previousBidderId, perkTitle: perk.title });
        }

        broadcastUpdates(perk.section);
    });
});

setInterval(async () => {
    if (!db) return;
    const activePerks = await db.all('SELECT * FROM Perks WHERE status = "active"');
    const now = new Date();
    for (const perk of activePerks) {
        if (new Date(perk.ends_at) <= now) {
            await db.run('UPDATE Perks SET status = "closed" WHERE id = ?', [perk.id]);
            io.to(perk.section).emit('auction_closed', { 
                perkTitle: perk.title, 
                winnerName: perk.highest_bidder_name || 'No Bids Placed',
                winningBid: perk.current_bid
            });
            broadcastUpdates(perk.section);
        }
    }
}, 3000);

setupDatabase().then((database) => {
    db = database;
    server.listen(3000, () => {
        console.log('Classroom Auction app running live on http://localhost:3000');
    });
});