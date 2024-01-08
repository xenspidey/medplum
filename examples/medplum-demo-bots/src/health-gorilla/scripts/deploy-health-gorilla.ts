import { GetFunctionCommand, LambdaClient, UpdateFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { ContentType, MedplumClient, getReferenceString, isOk, isResource, normalizeErrorString } from '@medplum/core';
import { Bot, ClientApplication, OperationOutcome, Project } from '@medplum/fhirtypes';
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

  if (!environment) {
    throw new Error('Missing environment name');
  }

  const secrets = JSON.parse(fs.readFileSync(path.resolve(__dirname, `${environment}.secrets.json`), 'utf8'));

  // Sign in to Medplum
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

  // Set up Health Gorilla Resources
  await createCallbackClient(medplum, project.id as string, secrets);
  await deployHealthGorillaBots(medplum, project, secrets);
  // await uploadOrderingQuestionnaire()
}

function ensureSecrets(secrets: Record<string, string>): void {
  const missingSecrets = HEALTH_GORILLA_INTEGRATION_SECRETS.filter((secretName) => !(secretName in secrets));
  if (missingSecrets.length > 0) {
    throw new Error(`Missing secrets: ${missingSecrets.join(',')}`);
  }
}

const HEALTH_GORILLA_CALLBACK_CLIENT_NAME = 'Health Gorilla Callback Client';
async function createCallbackClient(
  medplum: MedplumClient,
  projectId: string,
  secrets: Record<string, string>
): Promise<void> {
  let existingClient = await medplum.searchOne('ClientApplication', { name: HEALTH_GORILLA_CALLBACK_CLIENT_NAME });
  if (!existingClient) {
    process.stdout.write(`Creating new ClientApplication '${HEALTH_GORILLA_CALLBACK_CLIENT_NAME}'...`);
    existingClient = (await medplum.post(new URL(`admin/projects/${projectId}/client`, medplum.getBaseUrl()), {
      name: HEALTH_GORILLA_CALLBACK_CLIENT_NAME,
      description: 'Client for Health Gorilla to send data back to Medplum',
    })) as ClientApplication;
    process.stdout.write(`Success - ${getReferenceString(existingClient)}\n`);
  }

  secrets['HEALTH_GORILLA_CALLBACK_CLIENT_ID'] = existingClient.id as string;
  secrets['HEALTH_GORILLA_CALLBACK_CLIENT_SECRET'] = existingClient.secret as string;
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

async function deployHealthGorillaBots(
  medplum: MedplumClient,
  project: Project,
  secrets: Record<string, string>
): Promise<void> {
  const botIds: Record<string, string> = {};

  await Promise.all(
    HEALTH_GORILLA_BOTS.map(async (botDescription) => {
      let existingBot = await medplum.searchOne('Bot', {
        name: botDescription.name,
      });

      if (!existingBot) {
        console.log(`Creating new Bot [${botDescription.name}] ...`);
        const createBotUrl = new URL('admin/projects/' + (project.id as string) + '/bot', medplum.getBaseUrl());
        existingBot = (await medplum.post(createBotUrl, {
          name: botDescription.name,
          description: botDescription.description,
        })) as Bot;
        console.log(`Successfully created ${botDescription.name}: ${getReferenceString(existingBot)}`);
      }

      await updateHealthGorillaBot(medplum, existingBot, botDescription);
      botIds[existingBot.name as string] = existingBot.id as string;
    })
  );

  console.log(`Set "HEALTH_GORILLA_CALLBACK_BOT_ID" to ${botIds['receive-from-health-gorilla']}`);
  secrets['HEALTH_GORILLA_CALLBACK_BOT_ID'] = botIds['receive-from-health-gorilla'];

  ensureSecrets(secrets);
  await Promise.all(Object.values(botIds).map((botId) => updateBotSecrets(botId, secrets)));
}

async function updateHealthGorillaBot(medplum: MedplumClient, bot: Bot, botDescription: BotDescription): Promise<void> {
  console.log(`Updating Bot Metadata for [${botDescription.name}] (${getReferenceString(bot)})...`);
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
  console.log(`Successfully updated metadata for ${bot.name}`);

  console.log(`Deploying Bot '${bot.name}'...`);
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
    console.log(`Successfully deployed ${bot.name}`);
  }
}

async function updateBotSecrets(botId: string, secrets: Record<string, string>): Promise<void> {
  const lambdaName = `medplum-bot-lambda-${botId}`;
  console.log(`Updating ${lambdaName} secrets...`);
  const lambdaClient = new LambdaClient({});

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
          Variables: secrets,
        },
        Timeout: 90,
      })
    );
  } catch (e) {
    console.error(`Failure updating lambda ${lambdaName}: ${(e as Error).message}`);
  }
  console.log(`Successfully updated secrets for ${lambdaName}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch(console.error);
