# P2P Web Share Submission Notes

## Repository Requirement

Create a public or private GitHub repository for this project, for example:

```text
p2p-web-share
```

The repository should contain the full project folder:

```text
p2p-web-share/
|-- client/          React + Vite frontend
|-- server/          Node.js + Express + Socket.io signaling server
|-- README.md        Project description, setup, architecture, checklist
|-- package.json     Root helper scripts
`-- SUBMISSION_NOTES.md
```

## Required GitHub Repository Contents

The assignment asks for:

- Clean frontend code.
- Clean backend code.
- A `README.md` with:
  - Project description.
  - Setup instructions.
  - Deployment links.
- Source code for:
  - React frontend.
  - Node.js + Socket.io signaling backend.
  - WebRTC data channel file transfer.
  - Room creation and join flow.
  - Chunk hash verification.
  - Progress and connection status UI.
  - Graceful disconnect handling.
  - Auto download for receiver.

## Required Demo Video

Record a demo video of about 3 minutes showing:

- Sender selecting a file.
- Sender generating a share room link.
- Receiver opening the link in another browser window or device.
- WebRTC connection being established.
- File transfer progress.
- Receiver auto-downloading the transferred file.

Upload the demo video to one of:

- YouTube
- Google Drive

Then include the demo video link in the final submission.

## Deployment Links

The assignment expects deployment links in the README.

Recommended deployment:

- Frontend: Vercel or Netlify.
- Backend signaling server: Render or Railway.

Frontend environment variable:

```text
VITE_SIGNALING_URL=https://your-backend-url
```

Backend environment variable:

```text
CLIENT_ORIGIN=https://your-frontend-url
```

## Where To Submit

The assignment document only says to submit:

- GitHub repository link.
- Demo video link.
- Deployment links, if deployed.

It does not mention a specific portal, email address, or form. Submit these links wherever your class/platform/instructor asked you to submit the project.

## Current Local Status

Local project path:

```text
D:\p2p-web-share
```

Local development URLs:

```text
Frontend: http://127.0.0.1:5173
Backend:  http://127.0.0.1:3001
```

Known current issue:

- The sender UI can still get stuck at "Creating share room..." in the browser even though direct Socket.io room creation works from a local script. This needs to be debugged next in the browser/client runtime.
