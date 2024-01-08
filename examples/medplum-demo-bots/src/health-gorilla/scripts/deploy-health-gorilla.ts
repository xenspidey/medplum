import { GetFunctionCommand, LambdaClient, UpdateFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import {
  ContentType,
  MedplumClient,
  PatchOperation,
  getReferenceString,
  isOk,
  isResource,
  normalizeErrorString,
} from '@medplum/core';
import { Bot, OperationOutcome, Project } from '@medplum/fhirtypes';
import dotenv from 'dotenv';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// @ts-expect-error 1343
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEALTH_GORILLA_INTEGRATION_SECRETS: readonly string[] = [
  'HEALTH_GORILLA_BASE_URL',
  'HEALTH_GORILLA_CLIENT_ID',
  'HEALTH_GORILLA_CLIENT_SECRET',
  'HEALTH_GORILLA_CLIENT_URI',
  'HEALTH_GORILLA_USER_LOGIN',
  'HEALTH_GORILLA_PROVIDER_LAB_ACCOUNT',
  'HEALTH_GORILLA_TENANT_ID',
  'HEALTH_GORILLA_SUBTENANT_ID',
  'HEALTH_GORILLA_SUBTENANT_ACCOUNT_NUMBER',
  'HEALTH_GORILLA_SCOPES',
  'HEALTH_GORILLA_CALLBACK_BOT_ID',
  'HEALTH_GORILLA_CALLBACK_CLIENT_ID',
  'HEALTH_GORILLA_CALLBACK_CLIENT_SECRET',
  'HEALTH_GORILLA_AUDIENCE_URL',
];

async function main(): Promise<void> {
  const [, , environment] = process.argv;

  dotenv.config({ path: path.resolve(__dirname, `.env.${environment}`) });

  if (!environment) {
    throw new Error('Missing environment name');
  }
  const profilePath = path.resolve(homedir(), '.medplum', 'health-gorilla.json');
  const profile = JSON.parse(await fs.readFileSync(profilePath, 'utf-8'));
  const medplum = new MedplumClient();
  await medplum.setActiveLogin(JSON.parse(profile.activeLogin));

  if (!medplum.getAccessToken()) {
    throw new Error('Sign in failed');
  }

  const project = await medplum.searchOne('Project');
  if (!project?.id) {
    throw new Error('Project  not found: ' + JSON.stringify(medplum.getActiveLogin()));
  }

  await deployHealthGorillaBots(medplum, project);
}

interface BotDescription {
  identifier: string;
  name: string;
  description: string;
  src: string;
  dist: string;
}

const BOT_IDENTIFIER_SYSTEM = 'https://www.medplum.com/integrations/bot-identifier';
const HEALTH_GORILLA_BOTS: BotDescription[] = [
  {
    identifier: 'health-gorilla-labs/connection-test',
    name: 'connection-test',
    description: 'connection-test',
    src: 'connection-test.ts',
    dist: 'connection-test.js',
  },
  {
    identifier: 'health-gorilla-labs/receive-from-health-gorilla',
    name: 'receive-from-health-gorilla',
    description: 'receive-from-health-gorilla',
    src: 'receive-from-health-gorilla.ts',
    dist: 'receive-from-health-gorilla.js',
  },
  {
    identifier: 'health-gorilla-labs/send-to-health-gorilla',
    name: 'send-to-health-gorilla',
    description: 'receive-from-health-gorilla',
    src: 'send-to-health-gorilla.ts',
    dist: 'send-to-health-gorilla.js',
  },
  {
    identifier: 'health-gorilla-labs/setup-subscriptions',
    name: 'setup-subscriptions',
    description: 'receive-from-health-gorilla',
    src: 'setup-subscriptions.ts',
    dist: 'setup-subscriptions.js',
  },
];

async function deployHealthGorillaBots(medplum: MedplumClient, project: Project): Promise<void> {
  const botIds: Record<string, string> = {};

  for (const botDescription of HEALTH_GORILLA_BOTS) {
    let existingBot = await medplum.searchOne('Bot', {
      name: botDescription.name,
    });

    if (!existingBot) {
      process.stdout.write(`Creating new Bot [${botDescription.name}] ...`);
      const createBotUrl = new URL('admin/projects/' + (project.id as string) + '/bot', medplum.getBaseUrl());
      existingBot = (await medplum.post(createBotUrl, {
        name: botDescription.name,
        description: botDescription.description,
      })) as Bot;
      process.stdout.write(`Success. ${getReferenceString(existingBot)}\n`);
    }

    await updateHealthGorillaBot(medplum, existingBot, botDescription);
    botIds[existingBot.name as string] = existingBot.id as string;
  }

  await updateBotSecrets(existingBot);
}

async function updateHealthGorillaBot(medplum: MedplumClient, bot: Bot, botDescription: BotDescription): Promise<void> {
  process.stdout.write(`Updating Bot Metadata [${botDescription.name}](${getReferenceString(bot)})...`);
  bot.identifier = [{ system: BOT_IDENTIFIER_SYSTEM, value: botDescription.identifier }];
  bot.name = botDescription.name;
  bot.description = botDescription.description;

  const sourceCode = fs.readFileSync(path.resolve(__dirname, '..', botDescription.src), 'utf8');
  const executableCode = fs.readFileSync(
    path.resolve(__dirname, '../../../dist/health-gorilla', botDescription.dist),
    'utf8'
  );
  bot.sourceCode = await medplum.createAttachment(sourceCode, botDescription.src, ContentType.TYPESCRIPT);
  bot.executableCode = await medplum.createAttachment(executableCode, botDescription.src, ContentType.JAVASCRIPT);

  bot = await medplum.updateResource(bot);
  process.stdout.write('Success\n');

  process.stdout.write(`Deploying Bot '${bot.name}'...`);
  let result: OperationOutcome | undefined;
  try {
    result = (await medplum.post(medplum.fhirUrl('Bot', bot.id as string, '$deploy'), {
      code: executableCode,
      filename: botDescription.dist,
    })) as OperationOutcome;
  } catch (e) {
    if (isResource(e) && e.resourceType === 'OperationOutcome') {
      if (!e.issue?.[0].code?.includes('An update is in progress')) {
        throw new Error(normalizeErrorString(e), { cause: e });
      }
    }
    throw e;
  }

  if (isOk(result)) {
    process.stdout.write('Success\n');
  }
}

async function updateBotSecrets(bot: Bot): Promise<void> {
  const lambdaName = `medplum-bot-lambda-${bot.id}`;
  console.log(`Updating ${lambdaName} secrets...`);
  const lambdaClient = new LambdaClient({});
  if (!bot.id) {
    throw new Error(`Bot ${bot.name} is missing id`);
  }

  let sleepInterval = 500;
  let updatedSuccessfully = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    const lastUpdateStatus = await lambdaClient
      .send(
        new GetFunctionCommand({
          FunctionName: lambdaName,
        })
      )
      .then((e) => e.Configuration?.LastUpdateStatus);
    // https://docs.aws.amazon.com/lambda/latest/dg/functions-states.html
    if (lastUpdateStatus === 'Successful') {
      updatedSuccessfully = true;
      break;
    }
    await sleep(sleepInterval);
    sleepInterval *= 2;
  }

  if (!updatedSuccessfully) {
    throw new Error(`Lambda ${lambdaName} has not updated successfully`);
  }

  try {
    await lambdaClient.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: lambdaName,
        Environment: {
          Variables: Object.fromEntries(
            HEALTH_GORILLA_INTEGRATION_SECRETS.map((secret) => [secret, process.env[secret] as string])
          ),
        },
        Timeout: 90,
      })
    );
  } catch (e) {
    console.error(`Failure updating lambda ${lambdaName}: ${(e as Error).message}`);
  }
  console.log('Success');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch(console.error);
