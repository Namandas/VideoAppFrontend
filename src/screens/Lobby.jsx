import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSocket } from "../context/SocketProvider";

const LobbyScreen = () => {
  const [room, setRoom] = useState("");
  const [username, setUsername] = useState("");
  const socket = useSocket();
  const navigate = useNavigate();

  const handleSubmitForm = (e) => {
    e.preventDefault();
    if (!room || !username) return;
    socket.emit("join-room", { roomId: room, username });
    navigate(`/room/${room}`, { state: { username } });
  };

  return (
    <div className="App">
      <div className="card">
        <h1>Join a Room</h1>
        <form onSubmit={handleSubmitForm}>
          <label htmlFor="username">Username</label>
          <input
            type="text"
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your name"
            required
          />
          <label htmlFor="room">Room Number</label>
          <input
            type="text"
            id="room"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="Enter room ID"
            required
          />
          <button type="submit" style={{ width: '100%', marginTop: '1rem' }}>Join Room</button>
        </form>
      </div>
    </div>
  );
};

export default LobbyScreen;
