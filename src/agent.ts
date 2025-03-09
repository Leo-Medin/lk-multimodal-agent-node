// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  multimodal,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import fs from 'fs';
import nodemailer from 'nodemailer'; // For email sending

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env.local');
dotenv.config({ path: envPath });

const companyInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'companyInfo.json'), 'utf-8'));

const transporter = nodemailer.createTransport({
  service: 'Yandex', // This automatically sets the right host and port
  auth: {
    user: process.env.EMAIL,
    pass: process.env.EMAIL_PASS
  }
});

transporter.verify((error, success) => {
  if (error) {
    console.error("SMTP Connection Error:", error);
  } else {
    console.log("SMTP Connection Successful!");
  }
});

export default defineAgent({
  entry: async (ctx: JobContext) => {


    await ctx.connect();
    console.log('waiting for participant');
    const participant = await ctx.waitForParticipant();
    console.log(`starting assistant example agent for ${participant.identity}`);
    
    const model = new openai.realtime.RealtimeModel({
      instructions: 'You are a helpful assistant with real-time web search. When a user asks for information, always use the webSearch function unless told otherwise.',
      voice: 'alloy',
      model: 'gpt-4o-mini-realtime-preview-2024-12-17', // instead of default gpt-4o model for cost savings 
      maxResponseOutputTokens: 1500
    });

    const fncCtx: llm.FunctionContext = {
      companyInfo: {
        description: 'Retrieve company information (e.g., office hours, phone number, email, location, services).',
        parameters: z.object({ query: z.string().describe('The specific company information requested.') }),
        execute: async ({ query }) => {
          return companyInfo[query] || 'I could not find that information. Please check the official website.';
        },
      },

      bookAppointment: {
        description: 'Book a car service appointment.',
        parameters: z.object({
          name: z.string().describe('Customer name'),
          phoneNumber: z.string().describe('phoneNumber'),
          carModel: z.string().describe('Car model'),
          year: z.string().describe('Car year'),
          // number: z.string().describe('Number'),
          problem: z.string().describe('Issue description'),
          date: z.string().describe('Preferred appointment date and time')
        }),
        execute: async ({ name, carModel, year, problem, date }) => {

          const mailOptions = {
            from: process.env.EMAIL,
            to: process.env.OFFICE_EMAIL,
            subject: 'New Car Service Appointment',
            text: `New appointment request:\n\nName: ${name}\nCar Model: ${carModel} (${year})\nProblem: ${problem}\nPreferred Date: ${date}`
          };

          await transporter.sendMail(mailOptions);
          return 'Your appointment request has been sent to the office. They will contact you soon.';
        }
      },

      getServicePrice: {
        description: 'Retrieve the cost of a service.',
        parameters: z.object({ service: z.string().describe('Service name') }),
        execute: async ({ service }) => {
          console.log('service:', service);

          const priceData = JSON.parse(fs.readFileSync(path.join(__dirname, 'servicePrices.json'), 'utf-8'));

          // If the requested service is a synonym, map it to the correct name
          // if (priceData[service] && typeof priceData[service] === "string") {
          //   service = priceData[service]; // Map synonym to correct name
          //   console.log('service (2):', service);
          // }

          return priceData[service] ? `The cost of ${service} is ${priceData[service]}.` : 'Price information is not available.';
        }
      },

      weather: {
        description: 'Get the weather in a location',
        parameters: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async ({ location }) => {
          console.debug(`executing weather function for ${location}`);
          const response = await fetch(`https://wttr.in/${location}?format=%C+%t`);
          if (!response.ok) {
            throw new Error(`Weather API returned status: ${response.status}`);
          }
          const weather = await response.text();
          return `The weather in ${location} right now is ${weather}.`;
        },
      },

      webSearch: {
        description: "Search the web for information.",
        parameters: { query: "string" },
        execute: async ({ query }: { query: string }) => {
          console.log(`🔍 Web Search Triggered for Query: ${query}`);
          try {
            return await searchWebGetSummary(query)
          } catch (error) {
            console.log(`Error fetching search results: ${(error as Error).message}`);
            return `Error fetching search results: ${(error as Error).message}`;
          }
        },
      },
      
    };
    const agent = new multimodal.MultimodalAgent({ model, fncCtx });
    const session = await agent
      .start(ctx.room, participant)
      .then((session) => session as openai.realtime.RealtimeSession);
    
    session.conversation.item.create(llm.ChatMessage.create({
      role: llm.ChatRole.ASSISTANT,
      text: 'How can I help you today?',
    }));

    session.response.create();

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
