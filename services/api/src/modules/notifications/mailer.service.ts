import { Injectable, Logger } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import { loadEnv } from "../../config/env";

/**
 * Real SMTP delivery — in local dev this targets the Mailhog container
 * (see infrastructure/docker/docker-compose.yml), so sent mail is genuinely
 * visible at http://localhost:8025 rather than only logged. Point
 * SMTP_HOST/PORT/USER/PASSWORD at a real provider for staging/production.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    if (!this.transporter) {
      const env = loadEnv();
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      });
    }
    return this.transporter;
  }

  async send(params: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const env = loadEnv();
    try {
      await this.getTransporter().sendMail({
        from: env.MAIL_FROM_ADDRESS,
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: params.html,
      });
    } catch (err) {
      this.logger.error(`Failed to send email to ${params.to}: ${String(err)}`);
      throw err; // let BullMQ's retry/backoff handle transient SMTP failures
    }
  }
}
