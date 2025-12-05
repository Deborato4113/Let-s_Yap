// Your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyAfNDBFu3WlM5qEIVNZLkmzP_SnIGX_veg",
  authDomain: "chat-app-6a881.firebaseapp.com",
  projectId: "chat-app-6a881",
  storageBucket: "chat-app-6a881.firebasestorage.app",
  messagingSenderId: "242608606396",
  appId: "1:242608606396:web:5f2e1ee6fef370deb3d4b9",
  measurementId: "G-31XJEH8CCY",
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

const nameInput = document.getElementById("nameInput");
const roomSelect = document.getElementById("roomSelect");
const guestBtn = document.getElementById("guestBtn");
const googleBtn = document.getElementById("googleBtn");

guestBtn.onclick = () => {
  const name = nameInput.value.trim() || "Anonymous";
  const room = roomSelect.value || "General";

  saveUserAndGo({ displayName: name }, room);
};

googleBtn.onclick = async () => {
  const room = roomSelect.value || "General";
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    const result = await auth.signInWithPopup(provider);
    const user = result.user;
    saveUserAndGo(user, room);
  } catch (err) {
    alert("Google sign-in failed: " + err.message);
  }
};

function saveUserAndGo(user, room) {
  const userData = {
    uid: user.uid || null,
    name: user.displayName || user.email || "Anonymous",
    photoURL: user.photoURL || null,
    room,
  };
  localStorage.setItem("chatUser", JSON.stringify(userData));
  window.location.href = "/chat";
}
