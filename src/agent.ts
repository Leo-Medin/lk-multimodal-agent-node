// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, llm, multimodal } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import fs from 'fs';
import nodemailer from 'nodemailer'; // For email sending
import { loadTenantTxtKnowledge, searchDocs } from "./docSearchLib";

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

export default defineAgent({
  entry: async (ctx: JobContext) => {


    await ctx.connect();
    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);

    const BASE_INSTRUCTIONS = 'You are the voice assistant for Autolife car services.\n' +
    'Default to concise answers: 1–2 sentences, under ~15 seconds of speech.\n' +
    'If the user’s request is broad or would take longer, ask one clarifying question first.\n' +
    'Only give long explanations when the user explicitly asks for more detail (“tell me more”, “details”, “explain”).\n' +
    'If you are not sure, do not guess—ask or use tools.\n' +
    'Use searchDocs for any questions about services, pricing, hours, location, policies. If not found, ask one clarifying question.\n' +
    'When answering, use only the retrieved passages. If passages don’t contain the answer, ask one clarifying question or say it’s not in the docs.';

    const model = new openai.realtime.RealtimeModel({
      instructions: BASE_INSTRUCTIONS,
      voice: 'alloy',
      // model: 'gpt-4o-mini-realtime-preview-2024-12-17', // instead of default gpt-4o model for cost savings
      model: 'gpt-realtime-mini',
      maxResponseOutputTokens: 350 // about 15s answer
    });

    const fncCtx: llm.FunctionContext = {
      searchDocs: {
        description: 'Retrieve company information (e.g., office hours, phone number, email, location, services).',
        parameters: z.object({ query: z.string().describe('The specific company information requested.') }),
        execute: async ({ query }) => {
          const results = searchDocs({ index, query, topK: 3 });

          if (results.length === 0) {
            return JSON.stringify({
              found: false,
              message: "I couldn't find this in the provided documents. Do you want prices, location, opening hours, or services?",
            });
          }

          return JSON.stringify({
            found: true,
            passages: results.map(r => ({
              text: r.text,
              source: `Source: ${r.title} — ${r.sourceFile}`,
              chunkId: r.chunkId,
            })),
          });
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
          date: z.string().optional().describe('Preferred appointment date (ask if missing)')
        }),
        execute: async ({ name, phone, carModel, year, reason, date }) => {
          let responseText;
        
          try {
            let missingFields = [];
        
            if (!name) missingFields.push("your name");
            if (!phone) missingFields.push("your phone number");
            if (!carModel) missingFields.push("your car model");
            if (!year) missingFields.push("the year of your car");
            if (!reason) missingFields.push("why you are booking this service");
            if (!date) missingFields.push("the preferred appointment date");
        
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
        
            console.log("Response before sending:", responseText);
            return responseText;
          } catch (error) {
            console.error("Error in bookAppointment:", error);
            return "An error occurred while processing your request.";
          }
        }        
      },
            
      confirmAppointment: {
        description: 'Confirm the car service appointment before sending the email request. The user should say "yes" to proceed or "no" to modify details.',
        parameters: z.object({
          confirmation: z.string().describe('User confirmation response (yes or no)'),
          name: z.string(),
          phone: z.string(),
          carModel: z.string(),
          year: z.string(),
          reason: z.string(),
          date: z.string()
        }),
        execute: async ({ confirmation, name, phone, carModel, year, reason, date }) => {
          console.log('confirmAppointment() confirmation.toLowerCase():', confirmation.toLowerCase());
          if (confirmation.toLowerCase() !== 'yes') {
            return 'Please provide the correct details to proceed with your appointment.';
          }
            
          const mailOptions = {
            from: process.env.EMAIL,
            to: process.env.OFFICE_EMAIL,
            subject: 'New Car Service Appointment',
            text: `New appointment request:\n\nName: ${name}\nPhone: ${phone}\nCar Model: ${carModel} (${year})\nReason: ${reason}\nPreferred Date: ${date}`
          };
      
          await transporter.sendMail(mailOptions);
          return 'Your appointment request has been sent to the office. They will contact you soon.';
        }
      },

    };
    const agent = new multimodal.MultimodalAgent({ model, fncCtx });
    const session = await agent
      .start(ctx.room, participant)
      .then((session) => session as openai.realtime.RealtimeSession);

    // at session start
    let greeted = false;
    let userSpoke = false;

    const greetTimer = setTimeout(() => {
      if (greeted || userSpoke) return;
      greeted = true;

      session.conversation.item.create(
        llm.ChatMessage.create({
          role: llm.ChatRole.SYSTEM,
          text:
            'The user has been silent since the conversation started. ' +
            'Greet the user with EXACTLY one short sentence: "Hi! How can I help you?" ' +
            'Do not ask for booking details. Do not mention appointments unless the user asks. ' +
            'Do not add any other text.',
        })
      );

      session.response.create(); // first message from agent right from the start

    }, 3000);

    // Cancel greeting immediately when user starts speaking (best low-latency signal)
    session.on("openai_server_event_received", (ev: any) => {
      if (ev?.type === "input_audio_buffer.speech_started") {
        userSpoke = true;
        clearTimeout(greetTimer);
      }
    });

  },
});

cli.runApp(new WorkerOptions({ 
  agent: fileURLToPath(import.meta.url),
}));

const searchWebGetSummary = async (query: string) => {
  // console.log('process.env.BRAVE_API_KEY:', process.env.BRAVE_API_KEY);

  let response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${query}&summary=1`, {
    headers: {
      "X-Subscription-Token": process.env.BRAVE_API_KEY as string,
    },
  })
  const result = await response.json();

  if (result.error) {
    console.log('error:', result.error);
    console.log('error.meta:', result.error.meta);
    console.log('error.meta.errors[0]:', result.error.meta.errors[0]);

    throw(result.error.message? result.error.message: result.error)
  }

  let summaryKey;
  if(result.summarizer) summaryKey = result.summarizer.key.toString();
  // console.log('summaryKey:', summaryKey);

  const request2Url = `https://api.search.brave.com/res/v1/summarizer/search?key=${summaryKey}&entity_info=1`;
  // console.log('request2Url:', request2Url);

  const response2 = await fetch(request2Url, {
      headers: {
        "X-Subscription-Token": process.env.BRAVE_API_KEY as string,
      },
    })
  

  const result2 = await response2.json();


  if (result2.error) {
    console.log('error:', result2.error);
    console.log('error.meta:', result2.error.meta);
    console.log('error.meta.errors[0]:', result2.error.meta.errors[0]);

    throw(result2.error.message? result2.error.message: result2.error)
  }
  // console.log('summary:', result2.summary[0]?.data);

  return result2.summary[0]?.data;
}
