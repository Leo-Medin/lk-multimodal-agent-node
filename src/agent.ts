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
        description: `Book a car service appointment step by step. 
        - If any details are missing (name, phone, car model, year, problem, date), ask the user for them one by one.
        - Do not assume any details.
        - Once all details are collected, read them back to the user and ask them to confirm.`,
        parameters: z.object({
          name: z.string().optional().describe('Customer name (ask if missing)'),
          phone: z.string().optional().describe('Customer phone number (ask if missing)'),
          carModel: z.string().optional().describe('Car model (ask if missing)'),
          year: z.string().optional().describe('Car year (ask if missing)'),
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
              responseText = `I need the following details to book your appointment: ${missingFields.join(", ")}. Please provide them one by one.`;
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
          problem: z.string(),
          date: z.string()
        }),
        execute: async ({ confirmation, name, phone, carModel, year, problem, date }) => {
          if (confirmation.toLowerCase() !== 'yes') {
            return 'Please provide the correct details to proceed with your appointment.';
          }
            
          const mailOptions = {
            from: process.env.EMAIL,
            to: process.env.OFFICE_EMAIL,
            subject: 'New Car Service Appointment',
            text: `New appointment request:\n\nName: ${name}\nPhone: ${phone}\nCar Model: ${carModel} (${year})\nProblem: ${problem}\nPreferred Date: ${date}`
          };
      
          await transporter.sendMail(mailOptions);
          return 'Your appointment request has been sent to the office. They will contact you soon.';
        }
      },
      
      getServicePrice: {
        description: 'Retrieve the cost of a car service. The service name must always be in English. If the user provides a request in another language, first translate it to English before passing it here. Available services include oil change, brake pad replacement, tire change, engine diagnostics, wheel alignment, battery replacement, and more.',
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
