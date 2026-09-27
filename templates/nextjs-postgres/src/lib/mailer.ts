/**
 * Mail port. With `SMTP_HOST` set, mail goes out over SMTP (Mailpit in `compose.yaml`
 * development, your provider in production); without it, mail is written to the log so
 * flows like password reset work before any credentials exist.
 */
import nodemailer from "nodemailer";
import { env } from "@/env";
import { logger } from "@/lib/logger";

export type Mail = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function consoleMailer(): Mailer {
  return {
    async send(mail) {
      logger.info({ to: mail.to, subject: mail.subject, text: mail.text }, "mail (console adapter, not sent)");
    },
  };
}

export function smtpMailer(options: {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}): Mailer {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: options.user ? { user: options.user, pass: options.password ?? "" } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(mail) {
      await transport.sendMail({ from: options.from, ...mail });
    },
  };
}

let instance: Mailer | undefined;

export function getMailer(): Mailer {
  if (instance) return instance;
  instance = env.SMTP_HOST
    ? smtpMailer({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.SMTP_FROM,
      })
    : consoleMailer();
  return instance;
}

/** Send through the configured adapter. */
export async function sendMail(mail: Mail): Promise<void> {
  await getMailer().send(mail);
}
