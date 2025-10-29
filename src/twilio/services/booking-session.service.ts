import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface BookingAnswer {
  questionNo: number;
  question: string;
  answer: string;
  timestamp: string;
}

export interface BookingSession {
  callSid: string;
  status: 'active' | 'completed' | 'cancelled';
  currentQuestionNo: number;
  answers: BookingAnswer[];
  createdAt: string;
  lastUpdated: string;
  completedAt?: string;
  cancelledAt?: string;
  // New confirmation flow properties
  awaitingConfirmation: boolean;
  lastAnswer?: string;
  lastQuestionNo?: number;
  // Letter-by-letter email collection properties
  emailLetterByLetterMode: boolean;
  emailLetters: string[];
  currentEmailLetterIndex: number;
  awaitingLetterConfirmation: boolean;
  lastSpokenLetter?: string;
}

@Injectable()
export class BookingSessionService {
  private readonly logger = new Logger(BookingSessionService.name);
  private readonly sessionCache: Map<string, BookingSession> = new Map();
  private readonly logDirectory: string;

  constructor() {
    // Create logs directory for booking sessions
    this.logDirectory = path.join(process.cwd(), 'logs', 'booking-sessions');
    this.ensureLogDirectory();
  }

  /**
   * Ensures the booking log directory exists
   */
  private ensureLogDirectory(): void {
    try {
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true });
        this.logger.log(`Created booking session log directory: ${this.logDirectory}`);
      }
    } catch (error) {
      this.logger.error('Failed to create booking log directory:', error);
    }
  }

  /**
   * Creates a new booking session for a call
   */
  createBookingSession(callSid: string): BookingSession {
    const session: BookingSession = {
      callSid,
      status: 'active',
      currentQuestionNo: 1,
      answers: [],
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      // Initialize confirmation flow properties
      awaitingConfirmation: false,
      lastAnswer: undefined,
      lastQuestionNo: undefined,
      // Initialize letter-by-letter email properties
      emailLetterByLetterMode: false,
      emailLetters: [],
      currentEmailLetterIndex: 0,
      awaitingLetterConfirmation: false,
      lastSpokenLetter: undefined,
    };

    this.sessionCache.set(callSid, session);
    this.saveSession(session);

    this.logger.log(`📋 [BOOKING] Created new booking session for call: ${callSid}`);
    return session;
  }

  /**
   * Gets an existing booking session
   */
  getBookingSession(callSid: string): BookingSession | null {
    return this.sessionCache.get(callSid) || null;
  }

  /**
   * Adds an answer to the booking session
   */
  addAnswer(callSid: string, questionNo: number, question: string, answer: string): BookingSession | null {
    const session = this.sessionCache.get(callSid);
    if (!session) {
      this.logger.warn(`📋 [BOOKING] No session found for call: ${callSid}`);
      return null;
    }

    const bookingAnswer: BookingAnswer = {
      questionNo,
      question,
      answer,
      timestamp: new Date().toISOString(),
    };

    // Update or add the answer
    const existingAnswerIndex = session.answers.findIndex((a) => a.questionNo === questionNo);
    if (existingAnswerIndex >= 0) {
      session.answers[existingAnswerIndex] = bookingAnswer;
    } else {
      session.answers.push(bookingAnswer);
    }

    session.lastUpdated = new Date().toISOString();
    this.saveSession(session);

    this.logger.log(`📋 [BOOKING] Added answer for question ${questionNo} in call: ${callSid}`);
    return session;
  }

  /**
   * Moves to the next question
   */
  moveToNextQuestion(callSid: string): BookingSession | null {
    const session = this.sessionCache.get(callSid);
    if (!session) {
      this.logger.warn(`📋 [BOOKING] No session found for call: ${callSid}`);
      return null;
    }

    session.currentQuestionNo++;
    session.lastUpdated = new Date().toISOString();
    this.saveSession(session);

    this.logger.log(`📋 [BOOKING] Moved to question ${session.currentQuestionNo} for call: ${callSid}`);
    return session;
  }

  /**
   * Completes the booking session
   */
  completeBooking(callSid: string): BookingSession | null {
    const session = this.sessionCache.get(callSid);
    if (!session) {
      this.logger.warn(`📋 [BOOKING] No session found for call: ${callSid}`);
      return null;
    }

    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    session.lastUpdated = new Date().toISOString();
    this.saveSession(session);

    this.logger.log(`✅ [BOOKING] Completed booking for call: ${callSid}`);
    return session;
  }

  /**
   * Cancels the booking session
   */
  cancelBooking(callSid: string): BookingSession | null {
    const session = this.sessionCache.get(callSid);
    if (!session) {
      this.logger.warn(`📋 [BOOKING] No session found for call: ${callSid}`);
      return null;
    }

    session.status = 'cancelled';
    session.cancelledAt = new Date().toISOString();
    session.lastUpdated = new Date().toISOString();
    this.saveSession(session);

    this.logger.log(`❌ [BOOKING] Cancelled booking for call: ${callSid}`);
    return session;
  }

  /**
   * Clears the booking session (when call ends)
   */
  clearBookingSession(callSid: string): void {
    const session = this.sessionCache.get(callSid);
    if (session) {
      this.logger.log(`🧹 [BOOKING] Marking session for cleanup: ${callSid}`);
      // Don't delete immediately - mark for cleanup after response is sent
      session.status = 'cancelled';
      this.saveSession(session);

      // Set a delay to clear from memory after response processing
      setTimeout(() => {
        this.sessionCache.delete(callSid);
        this.logger.log(`🧹 [BOOKING] Session cleared from memory: ${callSid}`);
      }, 5000); // 5 second delay
    }
  }

  /**
   * Gets booking data in DB-friendly format
   */
  getBookingDataForDB(callSid: string): any | null {
    const session = this.sessionCache.get(callSid);
    if (!session) {
      return null;
    }

    // Convert to DB-friendly format
    const dbData = {
      callSid: session.callSid,
      status: session.status,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
      cancelledAt: session.cancelledAt,
      // Convert answers array to object for easier DB storage
      answers: session.answers.reduce((acc, answer) => {
        acc[`question_${answer.questionNo}`] = {
          question: answer.question,
          answer: answer.answer,
          timestamp: answer.timestamp,
        };
        return acc;
      }, {} as any),
    };

    return dbData;
  }

  /**
   * Saves a booking session to file
   */
  private saveSession(session: BookingSession): void {
    try {
      const filePath = path.join(this.logDirectory, `${session.callSid}.json`);
      const logContent = JSON.stringify(session, null, 2);
      fs.writeFileSync(filePath, logContent, 'utf8');
    } catch (error) {
      this.logger.error(`Failed to save booking session ${session.callSid}:`, error);
    }
  }

  /**
   * Gets the file path for a booking session
   */
  private getSessionFilePath(callSid: string): string {
    return path.join(this.logDirectory, `${callSid}.json`);
  }

  /**
   * Sets the session to await confirmation for the last answer
   */
  setAwaitingConfirmation(callSid: string, questionNo: number, answer: string): void {
    const session = this.getBookingSession(callSid);
    if (session) {
      session.awaitingConfirmation = true;
      session.lastAnswer = answer;
      session.lastQuestionNo = questionNo;
      session.lastUpdated = new Date().toISOString();
      this.saveSession(session);
      this.logger.log(`📋 [BOOKING] Set awaiting confirmation for Q${questionNo} in call: ${callSid}`);
    }
  }

  /**
   * Confirms the last answer and moves to next question
   */
  confirmAnswer(callSid: string): boolean {
    const session = this.getBookingSession(callSid);
    if (session && session.awaitingConfirmation && session.lastAnswer && session.lastQuestionNo) {
      // Add the confirmed answer
      this.addAnswer(callSid, session.lastQuestionNo, '', session.lastAnswer);

      // Reset confirmation state
      session.awaitingConfirmation = false;
      session.lastAnswer = undefined;
      session.lastQuestionNo = undefined;
      session.lastUpdated = new Date().toISOString();
      this.saveSession(session);

      this.logger.log(`✅ [BOOKING] Confirmed answer for Q${session.lastQuestionNo} in call: ${callSid}`);
      return true;
    }
    return false;
  }

  /**
   * Rejects the last answer and stays on the same question
   */
  rejectAnswer(callSid: string): void {
    const session = this.getBookingSession(callSid);
    if (session && session.awaitingConfirmation) {
      // Reset confirmation state but don't move to next question
      session.awaitingConfirmation = false;
      session.lastAnswer = undefined;
      session.lastQuestionNo = undefined;
      session.lastUpdated = new Date().toISOString();
      this.saveSession(session);

      this.logger.log(`❌ [BOOKING] Rejected answer for Q${session.lastQuestionNo} in call: ${callSid}`);
    }
  }

  /**
   * Checks if the session is awaiting confirmation
   */
  isAwaitingConfirmation(callSid: string): boolean {
    const session = this.getBookingSession(callSid);
    return session ? session.awaitingConfirmation : false;
  }

  /**
   * Starts letter-by-letter email collection mode
   */
  startEmailLetterByLetterMode(callSid: string): void {
    const session = this.getBookingSession(callSid);
    if (session) {
      session.emailLetterByLetterMode = true;
      session.emailLetters = [];
      session.currentEmailLetterIndex = 0;
      session.awaitingLetterConfirmation = false;
      session.lastSpokenLetter = undefined;
      session.lastUpdated = new Date().toISOString();
      this.saveSession(session);
      this.logger.log(`📧 [EMAIL] Started letter-by-letter mode for call: ${callSid}`);
    }
  }

  /**
   * Adds a letter to the email collection
   */
  addEmailLetter(callSid: string, letter: string): void {
    const session = this.getBookingSession(callSid);
    if (session && session.emailLetterByLetterMode) {
      session.emailLetters.push(letter);
      session.currentEmailLetterIndex = session.emailLetters.length;
      session.awaitingLetterConfirmation = false;
      session.lastSpokenLetter = undefined;
      session.lastUpdated = new Date().toISOString();
      this.saveSession(session);
      this.logger.log(`📧 [EMAIL] Added letter "${letter}" to email collection for call: ${callSid}`);
    }
  }

  /**
   * Sets awaiting letter confirmation
   */
  setAwaitingLetterConfirmation(callSid: string, letter: string): void {
    const session = this.getBookingSession(callSid);
    if (session && session.emailLetterByLetterMode) {
      session.awaitingLetterConfirmation = true;
      session.lastSpokenLetter = letter;
      session.lastUpdated = new Date().toISOString();
      this.saveSession(session);
      this.logger.log(`📧 [EMAIL] Set awaiting letter confirmation for "${letter}" in call: ${callSid}`);
    }
  }

  /**
   * Corrects the last letter in email collection
   */
  correctLastEmailLetter(callSid: string): void {
    const session = this.getBookingSession(callSid);
    if (session && session.emailLetterByLetterMode && session.emailLetters.length > 0) {
      session.emailLetters.pop(); // Remove last letter
      session.currentEmailLetterIndex = session.emailLetters.length;
      session.awaitingLetterConfirmation = false;
      session.lastSpokenLetter = undefined;
      session.lastUpdated = new Date().toISOString();
      this.saveSession(session);
      this.logger.log(`📧 [EMAIL] Removed last letter from email collection for call: ${callSid}`);
    }
  }

  /**
   * Completes email letter-by-letter collection
   */
  completeEmailLetterByLetter(callSid: string): string | null {
    const session = this.getBookingSession(callSid);
    if (session && session.emailLetterByLetterMode && session.emailLetters.length > 0) {
      const email = session.emailLetters.join('');
      session.emailLetterByLetterMode = false;
      session.emailLetters = [];
      session.currentEmailLetterIndex = 0;
      session.awaitingLetterConfirmation = false;
      session.lastSpokenLetter = undefined;
      session.lastUpdated = new Date().toISOString();
      this.saveSession(session);
      this.logger.log(`📧 [EMAIL] Completed letter-by-letter collection: "${email}" for call: ${callSid}`);
      return email;
    }
    return null;
  }

  /**
   * Gets current email being built
   */
  getCurrentEmail(callSid: string): string {
    const session = this.getBookingSession(callSid);
    if (session && session.emailLetterByLetterMode) {
      return session.emailLetters.join('');
    }
    return '';
  }

  /**
   * Checks if session is in email letter-by-letter mode
   */
  isInEmailLetterByLetterMode(callSid: string): boolean {
    const session = this.getBookingSession(callSid);
    return session ? session.emailLetterByLetterMode : false;
  }

  /**
   * Checks if session is awaiting letter confirmation
   */
  isAwaitingLetterConfirmation(callSid: string): boolean {
    const session = this.getBookingSession(callSid);
    return session ? session.awaitingLetterConfirmation : false;
  }
}
