import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";

// ─── Types ───────────────────────────────────────────────────────────

export type WizardSelectOption<T = string> = {
  value: T;
  label: string;
  hint?: string;
};

export type WizardSelectParams<T = string> = {
  message: string;
  options: Array<WizardSelectOption<T>>;
  initialValue?: T;
};

export type WizardTextParams = {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
};

export type WizardConfirmParams = {
  message: string;
  initialValue?: boolean;
};

export type WizardProgress = {
  update: (message: string) => void;
  stop: (message?: string) => void;
};

export type WizardPrompter = {
  intro: (title: string) => Promise<void>;
  outro: (message: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  select: <T>(params: WizardSelectParams<T>) => Promise<T>;
  text: (params: WizardTextParams) => Promise<string>;
  confirm: (params: WizardConfirmParams) => Promise<boolean>;
  progress: (label: string) => WizardProgress;
};

// ─── Cancellation ────────────────────────────────────────────────────

export class WizardCancelledError extends Error {
  constructor(message = "wizard cancelled") {
    super(message);
    this.name = "WizardCancelledError";
  }
}

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    throw new WizardCancelledError();
  }
  return value;
}

// ─── Factory ─────────────────────────────────────────────────────────

export function createClackPrompter(): WizardPrompter {
  return {
    intro: async (title) => {
      intro(title);
    },
    outro: async (message) => {
      outro(message);
    },
    note: async (message, title) => {
      note(message, title);
    },
    select: async <T>(params: WizardSelectParams<T>): Promise<T> => {
      const result = await select({
        message: params.message,
        options: params.options.map((opt) => ({
          value: opt.value as string,
          label: opt.label,
          ...(opt.hint ? { hint: opt.hint } : {}),
        })),
        initialValue: params.initialValue as string | undefined,
      });
      return guardCancel(result) as T;
    },
    text: async (params) =>
      guardCancel(
        await text({
          message: params.message,
          initialValue: params.initialValue,
          placeholder: params.placeholder,
          validate: params.validate ? (v) => params.validate!(v ?? "") : undefined,
        }),
      ),
    confirm: async (params) =>
      guardCancel(
        await confirm({
          message: params.message,
          initialValue: params.initialValue,
        }),
      ),
    progress: (label) => {
      const spin = spinner();
      spin.start(label);
      return {
        update: (message) => spin.message(message),
        stop: (message) => spin.stop(message),
      };
    },
  };
}
