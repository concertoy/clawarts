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
