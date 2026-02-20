// ==========================================
// AUTHENTICATION ROUTES (The Security Office)
// ==========================================
// This file handles:
// 1. Checking if names/emails are taken (Live Check).
// 2. Creating new users (Register).
// 3. Verifying users (Login).

const express = require('express');
// NOTE: We use bcryptjs (pure JS) to avoid native build tooling and
// transitive tar vulnerabilities that can show up in npm audit.
const bcrypt = require('bcryptjs'); // The Encryption Tool
const router = express.Router();

let db; // Placeholder for the database connection

// --- INITIALIZATION ---
// server.js calls this to give us the keys to the database.
router.init = (databaseConnection) => {
    db = databaseConnection;
};

// ==========================================
// ROUTE 1: LIVE CHECK (Username & Email)
// ==========================================
// This route is smarter now. It checks ANY field we send it.
router.post('/check-field', async (req, res) => {
    // Frontend sends: { field: 'username', value: 'Bob' }
    const { field, value } = req.body;
    
    console.log(`🔎 CHECKING ${field}: ${value}`); // <--- DEBUG LOG TO TERMINAL

    try {
        // DYNAMIC QUERY: "SELECT id FROM users WHERE [field] = [value]"
        // We use ?? for the column name to be safe from hackers (SQL Injection)
        const [rows] = await db.query(`SELECT id FROM users WHERE ?? = ?`, [field, value]);
        
        const isTaken = rows.length > 0;
        console.log(`   > Result: ${isTaken ? "TAKEN" : "AVAILABLE"}`); // <--- DEBUG LOG

        res.json({ taken: isTaken });

    } catch (err) {
        console.error("Auth Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});

// ==========================================
// ROUTE 2: REGISTER (Create User)
// ==========================================
router.post('/register', async (req, res) => {
    const { username, password, email, honeypot } = req.body;

    // Anti-Bot Trap (The Honeypot)
    // If this hidden field has text, it's a bot.
    if (honeypot && honeypot.length > 0) {
        return res.json({ success: true, message: "Account Created!" }); // Fake success
    }

    if (!username || !password || !email) {
        return res.json({ success: false, message: "All fields required." });
    }

    try {
        // Check for duplicates (Double check before saving)
        const [existing] = await db.query("SELECT id FROM users WHERE username = ? OR email = ?", [username, email]);
        if (existing.length > 0) {
            return res.json({ success: false, message: "Username or Email taken." });
        }

        // Encrypt Password
        // '10' is the complexity. Higher is safer but slower.
        const hash = await bcrypt.hash(password, 10);
        
        // Save to DB
        await db.query("INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)", [username, hash, email]);
        
        console.log(`✅ NEW USER: ${username}`);
        res.json({ success: true, message: "Welcome to the Carnage." });

    } catch (error) {
        console.error(error);
        res.json({ success: false, message: "Database Error" });
    }
});

// ==========================================
// ROUTE 3: LOGIN (Verify User)
// ==========================================
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Step 1: Find the user by name
        const [users] = await db.query("SELECT * FROM users WHERE username = ?", [username]);

        // If no user found, stop here.
        if (users.length === 0) {
            return res.json({ success: false, message: "User not found." });
        }

        const user = users[0]; // Get the first result

        // Step 2: Compare Passwords
        // We use bcrypt to compare the 'text' password with the 'scrambled' hash.
        const match = await bcrypt.compare(password, user.password_hash);

        if (match) {
            // SUCCESS!
            console.log(`🔓 LOGIN SUCCESS: ${username}`);
            
            // Send back the User ID so the browser remembers them.
            res.json({ 
                success: true, 
                userId: user.id, 
                username: user.username,
                role: user.role  // Send back their role too
            });
        } else {
            // FAILED
            console.log(`🔒 LOGIN FAILED: ${username}`);
            res.json({ success: false, message: "Wrong password." });
        }

    } catch (error) {
        console.error(error);
        res.json({ success: false, message: "Server Error" });
    }
});

module.exports = router;