export type InotesConfig = {
  baseUrl: string;
  mailPath: string;
  username?: string;
  password?: string;
  cookie?: string;
  /** Address-book name from the iNotes picker. Empty means the personal book. */
  directory?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InotesConfig {
  const baseRaw = (env.INOTES_BASE_URL ?? "").trim();
  const mailPathRaw = (env.INOTES_MAIL_PATH ?? "").trim();
  if (!baseRaw) {
    throw new Error("Задайте INOTES_BASE_URL — базовый URL сервера iNotes.");
  }

  let base: URL;
  try {
    base = new URL(baseRaw);
  } catch {
    throw new Error("INOTES_BASE_URL должен быть абсолютным URL, например https://mail.example.com");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("INOTES_BASE_URL должен использовать http или https.");
  }

  if (!mailPathRaw.startsWith("/") || mailPathRaw.includes("..") || /[?#\\]/.test(mailPathRaw)) {
    throw new Error("Задайте INOTES_MAIL_PATH — путь к почтовому NSF, например /mail/user.nsf");
  }

  const cookie = env.INOTES_COOKIE?.trim() || undefined;
  const username = env.INOTES_USERNAME?.trim() || undefined;
  const password = env.INOTES_PASSWORD;
  const hasPassword = password != null && password.length > 0;
  if (!cookie && (!username || !hasPassword)) {
    throw new Error("Задайте INOTES_COOKIE либо пару INOTES_USERNAME и INOTES_PASSWORD.");
  }

  const directory = env.INOTES_DIRECTORY?.trim() || undefined;

  return {
    baseUrl: base.origin,
    mailPath: mailPathRaw.replace(/\/+$/, ""),
    username,
    password: hasPassword ? password : undefined,
    cookie,
    directory,
  };
}
