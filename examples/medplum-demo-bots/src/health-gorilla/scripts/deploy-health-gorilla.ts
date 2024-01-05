import { LambdaClient, UpdateFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
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

  dotenv.config({ path: path.resolve(__dirname, `.env-${environment}`) });

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

  await updateProjectSecrets(medplum, project);
  await deployHealthGorillaBots(medplum, project);
}

async function updateProjectSecrets(medplum: MedplumClient, project: Project): Promise<void> {
  const ops: PatchOperation[] = [];

  if (!project.secret) {
    ops.push({ op: 'add', path: '/secret', value: [] });
    project.secret = [];
  }

  const toBeUpdated = new Set(HEALTH_GORILLA_INTEGRATION_SECRETS);

  const secrets = project.secret;

  secrets.forEach((secret, index) => {
    const secretName = secret.name as string;
    if (toBeUpdated.has(secretName)) {
      const secretVal = process.env[secretName];
      if (!secretVal) {
        throw new Error(`No value for secret '${secretName}'`);
      }
      ops.push({
        op: 'replace',
        path: `/secret/${index}`,
        value: {
          ...secret,
          valueString: secretVal,
        },
      });
      toBeUpdated.delete(secretName);
    }
  });

  toBeUpdated.forEach((secretName) => {
    const secretVal = process.env[secretName];
    if (!secretVal) {
      throw new Error(`No value for secret '${secretName}'`);
    }
    ops.push({
      op: 'add',
      path: `/secret/-`,
      value: {
        name: secretName,
        valueString: secretVal,
      },
    });
  });

  console.log('Updating Secrets...');
  console.log(JSON.stringify(ops, null, 2));
  await medplum.patchResource('Project', project.id as string, ops);
  console.log('Success');
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
    await updateBotSecrets(existingBot);
  }
}
// - [x] update the bot with the identifier + code
// - [x] deploy the bot
// - [x] update the lambda with secrets
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

  for (let attempt = 0; attempt < 5; attempt++) {
    process.stdout.write(`Deploying Bot: Attempt ${attempt + 1}...'`);
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
      break;
    }

    await sleep(1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function updateBotSecrets(bot: Bot): Promise<void> {
  console.log('Updating Lambda secrets...');
  const lambdaClient = new LambdaClient({});
  if (!bot.id) {
    throw new Error(`Bot ${bot.name} is missing id`);
  }
  const lambdaName = `medplum-bot-lambda-${bot.id}`;
  const command = new UpdateFunctionConfigurationCommand({
    FunctionName: lambdaName,
    Environment: {
      Variables: Object.fromEntries(
        HEALTH_GORILLA_INTEGRATION_SECRETS.map((secret) => [secret, process.env[secret] as string])
      ),
    },
  });
  try {
    await lambdaClient.send(command);
  } catch (e) {
    console.error(`Failure updating lambda ${lambdaName}: ${(e as Error).message}`);
  }
  console.log('Success');
}

main().catch(console.error);
