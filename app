<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video Calling and Messaging Application</title>
    <script src="https://www.gstatic.com/firebasejs/9.1.2/firebase-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/9.1.2/firebase-auth.js"></script>
    <script src="https://www.gstatic.com/firebasejs/9.1.2/firebase-database.js"></script>
    <style>
        /* Add basic CSS styles */
        body { font-family: Arial, sans-serif; margin: 20px; }
        #video-call, #chat { margin: 20px 0; }
        video { width: 300px; height: 200px; }
    </style>
</head>
<body>

    <h1>Video Calling and Messaging Application</h1>
    
    <div id="login">
        <h2>Login</h2>
        <button id="google-login">Login with Google</button>
        <input type="text" id="email" placeholder="Email">
        <input type="password" id="password" placeholder="Password">
        <button id="email-login">Login</button>
    </div>
    
    <div id="video-call" style="display: none;">
        <h2>Video Call</h2>
        <video id="user-video" autoplay></video>
        <video id="remote-video" autoplay></video>
        <button id="start-call">Start Call</button>
    </div>
    
    <div id="chat" style="display: none;">
        <h2>Chat</h2>
        <input type="text" id="message" placeholder="Type a message">
        <button id="send-message">Send</button>
        <div id="messages"></div>
    </div>
    
    <script>
        // Initialize Firebase
        const firebaseConfig = {
            apiKey: "YOUR_API_KEY",
            authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
            projectId: "YOUR_PROJECT_ID",
            storageBucket: "YOUR_PROJECT_ID.appspot.com",
            messagingSenderId: "YOUR_SENDER_ID",
            appId: "YOUR_APP_ID"
        };
        const app = firebase.initializeApp(firebaseConfig);
        const auth = firebase.auth();
        const database = firebase.database();

        // Google Login
        document.getElementById('google-login').onclick = function() {
            const provider = new firebase.auth.GoogleAuthProvider();
            auth.signInWithPopup(provider).then((result) => {
                document.getElementById('login').style.display = 'none';
                document.getElementById('video-call').style.display = 'block';
                document.getElementById('chat').style.display = 'block';
            }).catch(error => {
                console.error(error);
            });
        };

        // Email/Password Login
        document.getElementById('email-login').onclick = function() {
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            auth.signInWithEmailAndPassword(email, password).then(() => {
                document.getElementById('login').style.display = 'none';
                document.getElementById('video-call').style.display = 'block';
                document.getElementById('chat').style.display = 'block';
            }).catch(error => {
                console.error(error);
            });
        };

        // Video Call Functionality would go here (using WebRTC)

        // Messaging Functionality
        document.getElementById('send-message').onclick = function() {
            const message = document.getElementById('message').value;
            const messagesRef = database.ref('messages');
            messagesRef.push().set({ message: message });
            document.getElementById('message').value = '';
        };

        // Listen for new messages
        database.ref('messages').on('child_added', function(snapshot) {
            const msg = snapshot.val().message;
            const messageElement = document.createElement('div');
            messageElement.textContent = msg;
            document.getElementById('messages').appendChild(messageElement);
        });
    </script>
</body>
</html>
