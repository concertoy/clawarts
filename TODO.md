# TODO

## Attendance Check-in Feature

### Slack Limitations
- No IP address access (not exposed in API)
- No GPS/location data (no location API for bots)
- No device fingerprinting
- CAN get: message timestamp, user timezone (`users.info` → `tz`), online/away status (`users.getPresence`)

### Implementation Options

**Option A: Challenge-Response Check-in**
- Tutor opens a time-limited check-in window with a code/question (e.g. "What's on slide 12?" or a random PIN shown in class)
- Students must respond within the window (e.g. 5 minutes)
- Proves the student was paying attention in real-time

**Option B: QR Code / Passphrase**
- Tutor displays a QR code or passphrase on the projector during class
- Students send it to their bot agent
- Rotates every N minutes to prevent sharing

**Option C: Interactive Quiz Check-in**
- The check-in IS a quick quiz question about the lecture content
- Doubles as attendance + engagement check

**Option D: External Link for Location**
- Student agent sends a link to a web page that captures geolocation (browser `navigator.geolocation` API with user consent)
- Requires a small web server component — more complex

### Decision
TBD — Option A (challenge-response) is simplest, no external dependencies.

---

## Future LMS Features (Phase B+)

- **Grading & Feedback** — Score submissions, AI-assisted feedback, auto-relay grades to students
- **Q&A (Piazza-style)** — Students ask questions, tutor answers, broadcast to all, FAQ dedup
- **Course Materials** — Tutor shares files/URLs, students query them, RAG-lite
- **Progress Dashboard** — Per-student submission count, average grade, last activity, at-risk flags
