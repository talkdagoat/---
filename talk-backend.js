const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const dataFile = path.join(__dirname, 'data.json');

if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({
        users: {},
        messages: {}
    }, null, 2));
}

function readData() {
    const data = fs.readFileSync(dataFile, 'utf-8');
    return JSON.parse(data);
}

function writeData(data) {
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

app.post('/api/signup', (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const data = readData();

    if (data.users[email]) {
        return res.status(400).json({ error: 'Email already registered' });
    }

    const newUser = {
        id: Date.now().toString(),
        name: name,
        email: email,
        password: password,
        createdAt: new Date().toISOString()
    };

    data.users[email] = newUser;
    writeData(data);

    res.json({
        success: true,
        user: {
            id: newUser.id,
            name: newUser.name,
            email: newUser.email
        }
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    const data = readData();
    const user = data.users[email];

    if (!user || user.password !== password) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({
        success: true,
        user: {
            id: user.id,
            name: user.name,
            email: user.email
        }
    });
});

app.get('/api/users', (req, res) => {
    const data = readData();
    const users = Object.values(data.users).map(user => ({
        id: user.id,
        name: user.name,
        email: user.email
    }));

    res.json({ users });
});

app.post('/api/messages', (req, res) => {
    const { senderEmail, receiverEmail, text } = req.body;

    if (!senderEmail || !receiverEmail || !text) {
        return res.status(400).json({ error: 'All fields required' });
    }

    const data = readData();
    const messageKey = [senderEmail, receiverEmail].sort().join('_');

    if (!data.messages[messageKey]) {
        data.messages[messageKey] = [];
    }

    const newMessage = {
        id: Date.now().toString(),
        senderEmail: senderEmail,
        receiverEmail: receiverEmail,
        text: text,
        timestamp: new Date().toISOString()
    };

    data.messages[messageKey].push(newMessage);
    writeData(data);

    res.json({
        success: true,
        message: newMessage
    });
});

app.get('/api/messages/:email1/:email2', (req, res) => {
    const { email1, email2 } = req.params;
    const data = readData();
    const messageKey = [email1, email2].sort().join('_');
    const messages = data.messages[messageKey] || [];

    res.json({ messages });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => {
    console.log(`Talk Backend running on port ${PORT}`);
});
