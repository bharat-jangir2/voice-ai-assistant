import { LoggerService, LogLevel } from '@nestjs/common';

export class MyCustomLogger implements LoggerService {
  log(message: any, context?: string) {
    console.log(`📘 LOG ${this.format(context)} ${message}`);
  }

  error(message: any, trace?: string, context?: string) {
    console.error(`❌ ERROR ${this.format(context)} ${message}`);
    if (trace) console.error(trace);
  }

  warn(message: any, context?: string) {
    console.warn(`⚠️ WARN ${this.format(context)} ${message}`);
  }

  debug(message: any, context?: string) {
    console.debug(`🐞 DEBUG ${this.format(context)} ${message}`);
  }

  verbose(message: any, context?: string) {
    console.info(`🔍 VERBOSE ${this.format(context)} ${message}`);
  }

  fatal(message: any, context?: string) {
    console.error(`💀 FATAL ${this.format(context)} ${message}`);
  }

  private format(context?: string) {
    return context ? `[${context}]` : '';
  }
}
