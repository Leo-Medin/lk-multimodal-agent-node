// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { llm } from '@livekit/agents';
import { type JobContext, WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { z } from 'zod';
// For email sending
import { loadTenantTxtKnowledge, searchDocs } from './docSearchLib';

const tenantId = 'autolife'; // MVP
const index = loadTenantTxtKnowledge({
  tenantId,
  folderPath: process.env.KNOWLEDGE_DIR ?? './knowledge/autolife',
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env.local');
dotenv.config({ path: envPath });

const transporter = nodemailer.createTransport({
  service: 'Yandex', // This automatically sets the right host and port
  auth: {
    user: process.env.EMAIL,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP Connection Error:', error);
  } else {
    console.log('SMTP Connection Successful! ' + success);
  }
});

type Lang = 'en' | 'ru' | 'el' | undefined;

function detectLangFromText(text: string): Lang {
  const t = (text ?? '').trim();
  if (!t) return 'en';

  // Greek and Coptic + Greek Extended
  if (/[\u0370-\u03FF\u1F00-\u1FFF]/u.test(t)) return 'el';

  // Cyrillic + Cyrillic Supplement + Cyrillic Extended-A/B
  if (/[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]/u.test(t)) return 'ru';

  return 'en';
}

function langName(l: Lang) {
  return l === 'ru' ? 'Russian' : l === 'el' ? 'Greek' : 'English';
}

function notFoundMessage(l: Lang) {
  if (l === 'ru') {
    return 'Я не нашёл это в документах. Вам нужны цены, адрес, часы работы или список услуг?';
  }
  if (l === 'el') {
    return 'Δεν το βρήκα στα έγγραφα. Θέλετε τιμές, διεύθυνση, ωράριο ή υπηρεσίες;';
  }
  return "I couldn't find this in the provided documents. Do you want prices, location, opening hours, or services?";
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);
    let lastUserLang: Lang;

    const BASE_INSTRUCTIONS =
      'You are the voice assistant for Autolife car services.\n' +
      // 'You may respond ONLY in these languages: English, Greek, Russian.\n' +
      // 'If user speaks a different language, ask them to switch back to one of the supported languages.\n' +
      'Always respond in the language used by the user’s most recent message (English, Greek, or Russian). If the user’s message is in another language, ask them to switch to one of the supported languages.\n' +
      'Default to concise answers: 1–2 sentences, under ~15 seconds of speech.\n' +
      'If the user’s request is broad or would take longer, ask one clarifying question first.\n' +
      'Only give long explanations when the user explicitly asks for more detail (“tell me more”, “details”, “explain”).\n' +
      'If you are not sure, do not guess—ask or use tools.\n' +
      'Use searchDocs for any questions about services, pricing, hours, location, policies. If not found, ask one clarifying question.\n' +
      'When answering, use only the retrieved passages. If passages don’t contain the answer, ask one clarifying question or say it’s not in the docs.\n' +
      'When a tool returns "respondIn", you MUST write your final answer in that language.';

    const model = new openai.realtime.RealtimeModel({
      instructions: BASE_INSTRUCTIONS,
      voice: 'alloy',
      // model: 'gpt-4o-mini-realtime-preview-2024-12-17', // instead of default gpt-4o model for cost savings
      model: 'gpt-realtime-mini',
      maxResponseOutputTokens: 350, // about 15s answer
    });

    const fncCtx: llm.FunctionContext = {
      searchDocs: {
        description:
          'Retrieve company information (e.g., office hours, phone number, email, location, services).',
        parameters: z.object({
          query: z
            .string()
            .describe(
              "Search query in English for the company docs (keep it short, e.g. 'car wash price', 'opening hours').",
            ),
        }),
        execute: async ({ query }) => {
          if (!lastUserLang) {
            await new Promise((r) => setTimeout(r, 500)); // wait for user query transcription arrive and set the language
          }
          const userLang = lastUserLang; // use session state
          console.log('lastUserLang:', userLang, 'toolQuery:', query);

          const q = userLang === 'en' ? query : await translateToEnglish(query);

          const results = searchDocs({ index, query: q, topK: 3 });

          if (results.length === 0) {
            return JSON.stringify({
              found: false,
              respondIn: langName(userLang),
              message: notFoundMessage(userLang),
            });
          }

          const resultToReturn = {
            found: true,
            respondIn: langName(userLang),
            effectiveQuery: q,
            passages: results.map((r) => ({
              text: r.text,
              source: `Source: ${r.title} — ${r.sourceFile}`,
              chunkId: r.chunkId,
            })),
          };
          console.log('resultToReturn:', resultToReturn);
          return JSON.stringify(resultToReturn);
        },
      },

      bookAppointment: {
        description: `Book a car service appointment step by step. 
        - If any details are missing (name, phone, car model, year, reason, date), ask the user for them one by one.
        - Do not assume any details.
        - Once all details are collected, read them back to the user and ask them to confirm.`,
        parameters: z.object({
          name: z.string().optional().describe('Customer name (ask if missing)'),
          phone: z.string().optional().describe('Customer phone number (ask if missing)'),
          carModel: z.string().optional().describe('Car model (ask if missing)'),
          // carModel: z.string().min(2).max(30).describe("Car model (exact input, no auto-correct)."),
          year: z.string().optional().describe('Car year (ask if missing)'),
          // year: z.string().regex(/^\d{4}$/).describe("Car manufacturing year (must be exactly 4 digits)."),
          reason: z.string().optional().describe('Reason for visit (ask if missing)'),
          date: z.string().optional().describe('Preferred appointment date (ask if missing)'),
        }),
        execute: async ({ name, phone, carModel, year, reason, date }) => {
          let responseText;

          try {
            const missingFields = [];

            if (!name) missingFields.push('your name');
            if (!phone) missingFields.push('your phone number');
            if (!carModel) missingFields.push('your car model');
            if (!year) missingFields.push('the year of your car');
            if (!reason) missingFields.push('why you are booking this service');
            if (!date) missingFields.push('the preferred appointment date');

            if (missingFields.length > 0) {
              // responseText = `I need the following details to book your appointment: ${missingFields.join(", ")}. Please provide them one by one.`;
              responseText = `To book the appointment, what is ${missingFields[0]}?`;
            } else {
              responseText = `Please confirm your appointment details:\n
              - Name: ${name}
              - Phone: ${phone}
              - Car Model: ${carModel} (${year})
              - Reason: ${reason}
              - Preferred Date: ${date}\n
              Say 'yes' to confirm or 'no' to modify the details.`;
            }

            // console.log('Response before sending:', responseText);
            return responseText;
          } catch (error) {
            console.error('Error in bookAppointment:', error);
            return 'An error occurred while processing your request.';
          }
        },
      },

      confirmAppointment: {
        description:
          'Confirm the car service appointment before sending the email request. The user should say "yes" to proceed or "no" to modify details.',
        parameters: z.object({
          confirmation: z.string().describe('User confirmation response (yes or no)'),
          name: z.string(),
          phone: z.string(),
          carModel: z.string(),
          year: z.string(),
          reason: z.string(),
          date: z.string(),
        }),
        execute: async ({ confirmation, name, phone, carModel, year, reason, date }) => {
          console.log(
            'confirmAppointment() confirmation.toLowerCase():',
            confirmation.toLowerCase(),
          );
          if (confirmation.toLowerCase() !== 'yes') {
            return 'Please provide the correct details to proceed with your appointment.';
          }

          const mailOptions = {
            from: process.env.EMAIL,
            to: process.env.OFFICE_EMAIL,
            subject: 'New Car Service Appointment',
            text: `New appointment request:\n\nName: ${name}\nPhone: ${phone}\nCar Model: ${carModel} (${year})\nReason: ${reason}\nPreferred Date: ${date}`,
          };

          await transporter.sendMail(mailOptions);
          return 'Your appointment request has been sent to the office. They will contact you soon.';
        },
      },
    };

    const agent = new multimodal.MultimodalAgent({ model, fncCtx });

    const rtSession = await agent.start(ctx.room, participant);

    rtSession.on('input_speech_transcription_completed', (ev: unknown) => {
      const e = ev as { transcript?: string; itemId?: string }; // narrow to expected shape
      if (!e?.transcript) return;

      const transcript = e.transcript.trim();
      if (!transcript) return;

      lastUserLang = detectLangFromText(transcript);
      console.log('lastUserLang updated:', lastUserLang, 'from:', transcript);
    });
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
  }),
);

async function translateToEnglish(text: string): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: 'Translate to English. Output only the translation.' },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!r.ok) throw new Error(`translateToEnglish failed: ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() ?? text;
}
