const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');

async function setupDatabase() {
    const db = await open({
        filename: './auction.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS Users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            section TEXT,
            sections TEXT,
            avatar TEXT,
            password TEXT,
            role TEXT DEFAULT 'student',
            status TEXT DEFAULT 'active',
            coin_balance INTEGER DEFAULT 100,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS Perks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            section TEXT,
            title TEXT,
            description TEXT,
            starting_bid INTEGER DEFAULT 10,
            current_bid INTEGER DEFAULT 10,
            highest_bidder_id INTEGER,
            highest_bidder_name TEXT,
            status TEXT DEFAULT 'active',
            ends_at DATETIME
        );
        CREATE TABLE IF NOT EXISTS Bids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            perk_id INTEGER,
            user_id INTEGER,
            bid_amount INTEGER,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS TransactionHistory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount INTEGER,
            type TEXT,
            reason TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS Logins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    try { await db.exec(`ALTER TABLE Users ADD COLUMN section TEXT;`); } catch (e) {}
    try { await db.exec(`ALTER TABLE Users ADD COLUMN sections TEXT;`); } catch (e) {}
    try { await db.exec(`ALTER TABLE Users ADD COLUMN avatar TEXT;`); } catch (e) {}
    try { await db.exec(`ALTER TABLE Users ADD COLUMN status TEXT DEFAULT 'active';`); } catch (e) {}
    try { await db.exec(`ALTER TABLE Perks ADD COLUMN section TEXT;`); } catch (e) {}

    const teacherExists = await db.get('SELECT * FROM Users WHERE role = "teacher"');
    if (!teacherExists) {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        const defaultSections = JSON.stringify(['BSIT 1ST YEAR - A', 'BSHM 2ND YEAR - B']);
        await db.run('INSERT INTO Users (name, sections, avatar, password, role, coin_balance, status) VALUES (?, ?, ?, ?, "teacher", 0, "active")', [
            'Ms. Smith', defaultSections, 'https://api.dicebear.com/7.x/bottts/svg?seed=MsSmith', hashedPassword
        ]);
    }

    return db;
}

module.exports = setupDatabase;