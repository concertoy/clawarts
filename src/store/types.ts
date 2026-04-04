export interface Assignment {
  id: string;
  title: string;
  description: string;
  deadline: number; // epoch ms
  format: "individual" | "group";
  attachments: string[]; // URLs or file paths
  status: "open" | "closed";
  createdAt: number;
  createdBy: string; // tutor agent ID
}

export interface Submission {
  id: string;
  assignmentId: string;
  userId: string; // Slack user ID
  agentId: string; // student agent ID
  content: string; // text submission or file reference
  submittedAt: number;
  status: "submitted" | "late";
}

// ─── Check-in ────────────────────────────────────────────────────────

export interface PerStudentChallenge {
  userId: string;
  question: string;
}

export interface CheckinWindow {
  id: string;
  tutorId: string;
  mode: "passphrase" | "quiz" | "pulse" | "reflect";
  topic?: string; // quiz, reflect, pulse
  passphrase?: string; // passphrase mode only
  challenges?: PerStudentChallenge[]; // quiz mode: unique per student
  pulseGroupId?: string; // pulse mode: groups multiple windows
  pulseIndex?: number; // pulse mode: which micro-check (1-based)
  pulseTotal?: number; // pulse mode: total windows in group
  openedAt: number;
  closesAt: number;
  status: "open" | "closed";
}

export interface CheckinResponse {
  id: string;
  windowId: string;
  userId: string;
  agentId: string;
  content: string; // raw response text (student-writable)
  submittedAt: number; // server-set timestamp
  // Below fields: tutor-only (set by evaluate action)
  score?: number; // 0-100
  status?: "checked_in" | "late" | "absent" | "needs_review";
  feedback?: string;
  evaluatedAt?: number;
}
