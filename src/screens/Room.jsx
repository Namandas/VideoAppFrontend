import React, { useEffect, useState, useRef } from "react";
import ReactPlayer from "react-player";
import peer from "../service/peer";
import { useSocket } from "../context/SocketProvider";
import { useParams, useLocation, useNavigate } from "react-router-dom";

const RoomPage = () => {
  const socket = useSocket();
  const { roomId } = useParams();
  const [myStream, setMyStream] = useState();
  const [remoteStreams, setRemoteStreams] = useState({});
  const peersRef = useRef({});
  const [sourceLang, setSourceLang] = useState("");
  const [targetLang, setTargetLang] = useState("fr");
  const [transcribedText, setTranscribedText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingStreamRef = useRef(null);
  const intervalRef = useRef(null);
  const [translations, setTranslations] = useState([]);
  const localVideoRef = useRef(null);
  const remoteVideoRefs = useRef({});
  const [recorderError, setRecorderError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const myUsername = location.state?.username;
  // Redirect to Lobby if no username
  React.useEffect(() => {
    if (!myUsername) {
      navigate("/", { replace: true });
    }
  }, [myUsername, navigate]);
  const [usernames, setUsernames] = useState({});
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  // Add logging when updating usernames mapping
  const logUsernames = (msg, map) => {
    console.log(msg, JSON.stringify(map));
    return map;
  };

  useEffect(() => {
    (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      setMyStream(stream);
      // Only emit join-room if username is present
      if (myUsername) {
        socket.emit("join-room", { roomId, username: myUsername });
        setUsernames(prev => ({ ...prev, [socket.id]: myUsername }));
      }
    })();
    // Cleanup on unmount
    return () => {
      Object.values(peersRef.current).forEach((peer) => peer.close());
      peersRef.current = {};
      setRemoteStreams({});
    };
  }, [socket, roomId, myUsername]);

  // Robust multi-user signaling logic
  useEffect(() => {
    if (!myStream) return;

    // Handle list of users in the room (sent by server)
    const handleUsersInRoom = ({ users }) => {
      // Update usernames mapping first
      const nameMap = {};
      users.forEach(u => { nameMap[u.userId] = u.username; });
      setUsernames(prev => {
        const updated = { ...prev, ...nameMap };
        console.log('handleUsersInRoom usernames after mapping:', updated);
        return updated;
      });

      // Now create peer connections for each user
      users.forEach(({ userId, username }) => {
        if (peersRef.current[userId]) return;
        const newPeer = new RTCPeerConnection({
          iceServers: [
            { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
          ],
        });
        myStream.getTracks().forEach((track) => newPeer.addTrack(track, myStream));
        newPeer.ontrack = (event) => {
          setRemoteStreams((prev) => ({ ...prev, [userId]: event.streams[0] }));
        };
        newPeer.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit("ice-candidate", { to: userId, candidate: event.candidate });
          }
        };
        newPeer.createOffer().then((offer) => {
          newPeer.setLocalDescription(offer);
          socket.emit("offer", { to: userId, offer, username: myUsername });
        });
        peersRef.current[userId] = newPeer;
      });
    };

    // When a new user joins, only respond to their offer
    const handleUserJoined = ({ userId, username }) => {
      setUsernames(prev => logUsernames('handleUserJoined setUsernames', { ...prev, [userId]: username }));
      if (peersRef.current[userId]) return;
      const newPeer = new RTCPeerConnection({
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
        ],
      });
      myStream.getTracks().forEach((track) => newPeer.addTrack(track, myStream));
      newPeer.ontrack = (event) => {
        setRemoteStreams((prev) => ({ ...prev, [userId]: event.streams[0] }));
      };
      newPeer.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", { to: userId, candidate: event.candidate });
        }
      };
      peersRef.current[userId] = newPeer;
    };

    const handleOffer = async ({ from, offer, username }) => {
      setUsernames(prev => logUsernames('handleOffer setUsernames', { ...prev, [from]: username }));
      if (!peersRef.current[from]) {
        const newPeer = new RTCPeerConnection({
          iceServers: [
            { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
          ],
        });
        myStream.getTracks().forEach((track) => newPeer.addTrack(track, myStream));
        newPeer.ontrack = (event) => {
          setRemoteStreams((prev) => ({ ...prev, [from]: event.streams[0] }));
        };
        newPeer.onicecandidate = (event) => {
          if (event.candidate) {
            socket.emit("ice-candidate", { to: from, candidate: event.candidate });
          }
        };
        peersRef.current[from] = newPeer;
      }
      const peer = peersRef.current[from];
      await peer.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit("answer", { to: from, answer, username: myUsername });
    };

    const handleAnswer = async ({ from, answer, username }) => {
      setUsernames(prev => logUsernames('handleAnswer setUsernames', { ...prev, [from]: username }));
      const peer = peersRef.current[from];
      if (peer) {
        await peer.setRemoteDescription(new RTCSessionDescription(answer));
      }
    };

    const handleIceCandidate = async ({ from, candidate }) => {
      const peer = peersRef.current[from];
      if (peer && candidate) {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      }
    };

    const handleUserLeft = ({ userId }) => {
      if (peersRef.current[userId]) {
        peersRef.current[userId].close();
        delete peersRef.current[userId];
        setRemoteStreams((prev) => {
          const newState = { ...prev };
          delete newState[userId];
          return newState;
        });
      }
    };

    socket.on("users-in-room", handleUsersInRoom);
    socket.on("user-joined", handleUserJoined);
    socket.on("offer", handleOffer);
    socket.on("answer", handleAnswer);
    socket.on("ice-candidate", handleIceCandidate);
    socket.on("user-left", handleUserLeft);

    return () => {
      socket.off("users-in-room", handleUsersInRoom);
      socket.off("user-joined", handleUserJoined);
      socket.off("offer", handleOffer);
      socket.off("answer", handleAnswer);
      socket.off("ice-candidate", handleIceCandidate);
      socket.off("user-left", handleUserLeft);
    };
  }, [myStream, socket, myUsername]);

  // Handle usernames from server events
  useEffect(() => {
    // When joining, set your own username
    setUsernames(prev => logUsernames('init setUsernames', { ...prev, [socket.id]: myUsername }));
    // Handle users-in-room event
    const handleUsersInRoom = ({ users }) => {
      const nameMap = {};
      users.forEach(u => { nameMap[u.userId] = u.username; });
      setUsernames(prev => logUsernames('effect handleUsersInRoom setUsernames', { ...prev, ...nameMap }));
    };
    socket.on("users-in-room", handleUsersInRoom);
    return () => {
      socket.off("users-in-room", handleUsersInRoom);
    };
  }, [socket, myUsername]);

  // Request missing usernames for remote streams
  useEffect(() => {
    Object.keys(remoteStreams).forEach(userId => {
      if (!usernames[userId]) {
        socket.emit('request-username', { userId });
      }
    });
  }, [remoteStreams, usernames, socket]);

  // Listen for username-response from server
  useEffect(() => {
    const handleUsernameResponse = ({ userId, username }) => {
      setUsernames(prev => logUsernames('username-response setUsernames', { ...prev, [userId]: username }));
    };
    socket.on('username-response', handleUsernameResponse);
    return () => {
      socket.off('username-response', handleUsernameResponse);
    };
  }, [socket]);

  useEffect(() => {
    if (!socket) return;
    const handleTranslationMessage = ({ userId, translation, transcription }) => {
      setTranslations(prev => [
        { userId, translation, transcription, timestamp: Date.now() },
        ...prev.slice(0, 19) // keep only last 20
      ]);
    };
    socket.on('translation-message', handleTranslationMessage);
    return () => {
      socket.off('translation-message', handleTranslationMessage);
    };
  }, [socket]);

  // Attach myStream to local video
  useEffect(() => {
    if (localVideoRef.current && myStream) {
      localVideoRef.current.srcObject = myStream;
    }
  }, [myStream]);

  // Attach remote streams to video elements
  useEffect(() => {
    Object.entries(remoteStreams).forEach(([userId, stream]) => {
      if (remoteVideoRefs.current[userId] && stream instanceof MediaStream) {
        remoteVideoRefs.current[userId].srcObject = stream;
      }
    });
  }, [remoteStreams]);

  // Only depend on myStream for MediaRecorder setup
  useEffect(() => {
    if (!myStream) return;
    if (mediaRecorderRef.current) return;
    const audioStream = new MediaStream(myStream.getAudioTracks());
    recordingStreamRef.current = audioStream;
    // Robust mimeType selection
    let mimeType = '';
    if (window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      mimeType = 'audio/webm;codecs=opus';
    } else if (window.MediaRecorder.isTypeSupported('audio/webm')) {
      mimeType = 'audio/webm';
    } else if (window.MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
      mimeType = 'audio/ogg;codecs=opus';
    } else if (window.MediaRecorder.isTypeSupported('audio/ogg')) {
      mimeType = 'audio/ogg';
    } else if (window.MediaRecorder.isTypeSupported('audio/wav')) {
      mimeType = 'audio/wav';
    }
    let mediaRecorder;
    try {
      mediaRecorder = mimeType
        ? new window.MediaRecorder(audioStream, { mimeType })
        : new window.MediaRecorder(audioStream);
      mediaRecorderRef.current = mediaRecorder;
    } catch (err) {
      console.error('Failed to create MediaRecorder:', err);
      setRecorderError('Your browser does not support audio recording for translation.');
      return;
    }
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunksRef.current.push(e.data);
      }
    };
    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
      audioChunksRef.current = [];
      const formData = new FormData();
      // Use the correct file extension for the mimeType
      let ext = 'webm';
      if (mimeType.includes('ogg')) ext = 'ogg';
      else if (mimeType.includes('wav')) ext = 'wav';
      formData.append('audio', audioBlob, `audio.${ext}`);
      // Use latest values for sourceLang and targetLang
      formData.append('sourceLang', sourceLangRef.current);
      formData.append('targetLang', targetLangRef.current);
      try {
        const response = await fetch('https://videoappbackend-nycc.onrender.com/api/translate', {
          method: 'POST',
          body: formData
        });
        const data = await response.json();
        if (data.transcription) setTranscribedText(data.transcription);
        if (data.translation) setTranslatedText(data.translation);
        socket.emit('translation-message', {
          translation: data.translation,
          transcription: data.transcription,
          userId: socket.id
        });
      } catch (err) {
        setTranscribedText('Error transcribing');
        setTranslatedText('Error translating');
      }
    };
    try {
      mediaRecorder.start();
    } catch (err) {
      console.error('Failed to start MediaRecorder:', err);
      setRecorderError('Failed to start audio recording for translation.');
      return;
    }
    intervalRef.current = setInterval(() => {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.requestData();
        try {
          mediaRecorder.stop();
        } catch (e) {
          console.warn('MediaRecorder stop error:', e);
        }
        setTimeout(() => {
          if (mediaRecorder.state !== 'recording') {
            try {
              mediaRecorder.start();
            } catch (e) {
              console.warn('MediaRecorder start error:', e);
              setRecorderError('Failed to restart audio recording for translation.');
            }
          }
        }, 100);
      }
    }, 2000);
    return () => {
      try {
        if (mediaRecorderRef.current) {
          mediaRecorderRef.current.stop();
          mediaRecorderRef.current = null;
        }
      } catch (e) {
        console.warn('MediaRecorder cleanup error:', e);
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (recordingStreamRef.current && recordingStreamRef.current !== myStream) {
        recordingStreamRef.current.getTracks().forEach((t) => t.stop());
        recordingStreamRef.current = null;
      }
    };
  }, [myStream]);

  // Keep refs in sync with latest language values
  const sourceLangRef = useRef(sourceLang);
  const targetLangRef = useRef(targetLang);
  useEffect(() => { sourceLangRef.current = sourceLang; }, [sourceLang]);
  useEffect(() => { targetLangRef.current = targetLang; }, [targetLang]);

  const toggleAudio = () => {
    if (myStream) {
      myStream.getAudioTracks().forEach(track => {
        track.enabled = !audioEnabled;
      });
      setAudioEnabled(a => !a);
    }
  };
  const toggleVideo = () => {
    if (myStream) {
      myStream.getVideoTracks().forEach(track => {
        track.enabled = !videoEnabled;
      });
      setVideoEnabled(v => !v);
    }
  };

  // Leave room handler
  const handleLeaveRoom = () => {
    // Notify others immediately
    socket.emit("user-left", { roomId, userId: socket.id });
    // Stop all local media tracks
    if (myStream) {
      myStream.getTracks().forEach(track => track.stop());
      setMyStream(null);
    }
    // Close all peer connections
    Object.values(peersRef.current).forEach(peer => peer.close());
    peersRef.current = {};
    setRemoteStreams({});
    // Remove all socket listeners for this room
    socket.off("users-in-room");
    socket.off("user-joined");
    socket.off("offer");
    socket.off("answer");
    socket.off("ice-candidate");
    socket.off("user-left");
    socket.off("username-response");
    socket.off("translation-message");
    // Navigate back to Lobby
    navigate("/", { replace: true });
  };

  return (
    <div className="App">
      <div className="card" style={{ maxWidth: 700, width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1>Room</h1>
          <button onClick={handleLeaveRoom} style={{ padding: '8px 16px', background: '#e53935', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}>Leave Room</button>
        </div>
        {/* Language selection UI */}
        <div style={{ marginBottom: 24, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }}>
            <label>Source Language</label>
            <select value={sourceLang} onChange={e => setSourceLang(e.target.value)}>
              <option value="">Auto Detect</option>
              <option value="en">English</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="de">German</option>
              <option value="zh">Chinese</option>
              <option value="hi">Hindi</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Target Language</label>
            <select value={targetLang} onChange={e => setTargetLang(e.target.value)}>
              <option value="en">English</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="de">German</option>
              <option value="zh">Chinese</option>
              <option value="hi">Hindi</option>
            </select>
          </div>
        </div>
        {recorderError && (
          <div style={{ color: 'red', marginBottom: 16, textAlign: 'center' }}>
            {recorderError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 32 }}>
          {myStream && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{myUsername} (You)</div>
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                style={{ width: 220, height: 130, background: '#000', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}
              />
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'center', gap: 12 }}>
                <button onClick={toggleAudio} style={{ padding: '6px 16px', borderRadius: 6, background: audioEnabled ? '#6366f1' : '#cbd5e1', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer' }}>
                  {audioEnabled ? 'Mute' : 'Unmute'}
                </button>
                <button onClick={toggleVideo} style={{ padding: '6px 16px', borderRadius: 6, background: videoEnabled ? '#06b6d4' : '#cbd5e1', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer' }}>
                  {videoEnabled ? 'Camera Off' : 'Camera On'}
                </button>
              </div>
            </div>
          )}
          {Object.entries(remoteStreams).map(([userId, stream]) => (
            <div key={userId} style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {usernames[userId] || userId}
              </div>
              <video
                ref={el => (remoteVideoRefs.current[userId] = el)}
                autoPlay
                playsInline
                style={{ width: 220, height: 130, background: '#000', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}
              />
            </div>
          ))}
        </div>
        {/* Speech-to-Text and Translation UI */}
        <div style={{ marginTop: 16, padding: 16, border: '1.5px solid #e0e7ef', borderRadius: 12, background: '#f8fafc', marginBottom: 24 }}>
          <h2 style={{ marginTop: 0 }}>Live Speech Translation</h2>
          <div style={{ marginBottom: 12 }}>
            <label>Your Speech (Transcribed):</label>
            <div style={{ minHeight: 40, background: '#f1f5f9', padding: 8, borderRadius: 6, marginBottom: 8, color: '#374151' }}>
              {transcribedText ? transcribedText : <span style={{ color: '#888' }}>[Your speech will appear here]</span>}
            </div>
          </div>
          <div>
            <label>Translation:</label>
            <div style={{ minHeight: 40, background: '#e0f7fa', padding: 8, borderRadius: 6, color: '#007b00', fontWeight: 500 }}>
              {translatedText ? translatedText : <span style={{ color: '#888' }}>[Translation will appear here]</span>}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <h3>All Translations</h3>
          <div style={{ maxHeight: 180, overflowY: 'auto', background: '#f4f4f8', padding: 8, borderRadius: 6 }}>
            {translations.length === 0 && <div style={{ color: '#888' }}>[No translations yet]</div>}
            {translations.map((t, idx) => (
              <div key={t.timestamp + t.userId + idx} style={{ marginBottom: 8, padding: 6, borderRadius: 4, background: t.userId === socket.id ? '#e0e7ff' : '#fff' }}>
                <b>{usernames[t.userId] || t.userId}{t.userId === socket.id ? ' (You)' : ''}:</b><br />
                <span style={{ color: '#555' }}>{t.transcription}</span><br />
                <span style={{ color: '#007b00', fontWeight: 500 }}>{t.translation}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default RoomPage;
