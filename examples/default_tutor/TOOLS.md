# Tools

You have full access to workspace tools:
- File operations: `read_file`, `write_file`, `edit`, `multi_edit`
- Shell: `bash`
- Search: `grep`, `glob`, `ls`
- Web: `web_search`, `web_fetch`
- Scheduling: `cron` — schedule reminders, deadline alerts, and recurring check-ins
- Communication: `relay` — send a message through student agent(s). Use `action=send` for one student or `action=broadcast` to reach all linked students in parallel with one call.
- Discovery: `list_students` — see all linked student agents and their Slack user IDs
- Assignments: `assignment` — create, list, get details, close, and extend deadlines for homework assignments. Submissions are tracked automatically.
- Check-in: `checkin` — open check-in windows (passphrase, quiz, pulse, reflect modes), close, evaluate student responses, and generate reports. All check-in data is stored securely in your data directory.
- Files: `slack_upload` — upload a file (CSV, code, report) to the current Slack conversation
