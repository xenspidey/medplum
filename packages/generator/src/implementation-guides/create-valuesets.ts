import dotenv from 'dotenv';
import fsExtra from 'fs-extra';
import fetch from 'node-fetch';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import fs, { readFileSync, writeFileSync } from 'fs';
import path, { resolve } from 'path';
import { StructureDefinition, ValueSet } from '@medplum/fhirtypes';
import { fetchCtsNlmNihGovValueSetFromUrl } from './fetch-valuesets';

async function fetchUrlContentsToFile(url: string, outputFilename: string): Promise<void> {
  // Ideally this would pipe directly to the file instead of reading into memory,
  // but that is apparently not all that straightforward in Node. Attempted
  // to put together a version based on packages/server/src/fhir/binary.ts, but got
  // a zlib "incorrect header check" error.
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Error fetching the file: ${resp.statusText}`);
  }
  const text = await resp.text();
  fs.writeFileSync(outputFilename, text);
}

function coalesce(...args: (string | undefined)[]): string | undefined {
  return args.find((value) => value !== undefined && value !== '') ?? args[args.length - 1];
}

function readJson(filename: string): any {
  return JSON.parse(readFileSync(resolve(__dirname, filename), 'utf8'));
}

function writeJson(input: any, filename: string, pretty?: boolean): void {
  let jsonString: string;
  if (pretty) {
    jsonString = JSON.stringify(input, undefined, 2);
  } else {
    jsonString = JSON.stringify(input);
  }
  writeFileSync(filename, jsonString);
}

type Concept = { code: string; display: string };
type SystemToConceptList = { [system: string]: Concept[] };

function excludeSystemsAndConcepts(valueSet: ValueSet, systemToConcepts: SystemToConceptList): void {
  if (valueSet.expansion?.contains) {
    for (const entry of valueSet.expansion.contains) {
      if (!entry.system) {
        console.warn(`No system found: ${JSON.stringify(entry)}`);
        continue;
      }

      if (!entry.code) {
        console.warn(`No code found: ${JSON.stringify(entry)}`);
        continue;
      }

      if (!entry.display) {
        console.warn(`No display found: ${JSON.stringify(entry)}`);
      }

      const concepts = systemToConcepts[entry.system];
      if (!concepts) {
        console.log(`system of excluded entry not found: ${JSON.stringify(entry)}`);
        continue;
      }

      const index = concepts.findIndex((c) => c.code === entry.code);
      if (index === -1) {
        console.log(`code of excluded entry not found: ${JSON.stringify(entry)}`);
        continue;
      }

      concepts.splice(index, 1);
    }
  }
}

function includeSystemsAndConcepts(valueSet: ValueSet, systemToConcepts: SystemToConceptList): void {
  if (valueSet.expansion?.contains) {
    for (const entry of valueSet.expansion.contains) {
      if (!entry.system) {
        console.warn(`include entry has no system: ${JSON.stringify(entry)}`);
        continue;
      }

      if (!entry.code) {
        console.warn(`include entry has no code: ${JSON.stringify(entry)}`);
        continue;
      }

      if (!entry.display) {
        console.warn(`include entry has no display: ${JSON.stringify(entry)}`);
      }

      systemToConcepts[entry.system] ??= [];
      systemToConcepts[entry.system].push({ code: entry.code, display: entry.display ?? '' });
    }
  }
}

async function createValueSetFromExpansion({
  templateFilename,
  includedValueSets,
  excludedValueSets,
}: {
  templateFilename: string;
  includedValueSets: string[];
  excludedValueSets?: string[];
}): Promise<ValueSet> {
  const vs = readJson(templateFilename) as ValueSet;
  const systemToConcepts: SystemToConceptList = Object.create(null);
  excludedValueSets ??= [];

  // includes

  if (includedValueSets.length !== vs.compose?.include?.length) {
    throw new Error(
      `Expected ${includedValueSets.length} included value sets but found ${vs.compose?.include?.length}`
    );
  }

  for (const incl of vs.compose.include) {
    // console.log(incl);

    const vsUrl = incl.valueSet?.[0];
    if (!vsUrl) {
      throw new Error(`Unexpected include entry: ${JSON.stringify(incl)}`);
    }
    if (!includedValueSets.includes(vsUrl)) {
      throw new Error(`Unexpected include ValueSet ${vsUrl}`);
    }

    const includedVs = await fetchCtsNlmNihGovValueSetFromUrl(vsUrl);
    includeSystemsAndConcepts(includedVs, systemToConcepts);
  }

  // excludes

  if (excludedValueSets.length !== (vs.compose?.exclude?.length ?? 0)) {
    throw new Error(
      `Expected ${excludedValueSets.length} excluded value sets but found ${vs.compose?.exclude?.length}`
    );
  }

  if (vs.compose.exclude) {
    for (const excl of vs.compose.exclude) {
      const vsUrl = excl.valueSet?.[0];
      if (!vsUrl) {
        throw new Error(`Unexpected exclude entry: ${JSON.stringify(excl)}`);
      }
      if (!excludedValueSets.includes(vsUrl)) {
        throw new Error(`Unexpected exclude ValueSet ${vsUrl}`);
      }

      const excludedValueSet = await fetchCtsNlmNihGovValueSetFromUrl(vsUrl);
      excludeSystemsAndConcepts(excludedValueSet, systemToConcepts);
    }
  }

  // Build the final include
  vs.compose = {};
  vs.compose.include = [];
  for (const [system, concepts] of Object.entries(systemToConcepts)) {
    vs.compose.include.push({ system, concept: concepts });
  }

  return vs;
}

async function createValueSetFromExtension(extensionStructureDefinitionFilename: string): Promise<ValueSet> {
  const sd = readJson(extensionStructureDefinitionFilename) as StructureDefinition;
  const elem = sd.snapshot?.element?.find((elem) => elem.path === 'Extension.value[x]');

  if (!elem) {
    throw new Error('could not find Extension.value[x] in genderIdentity StructureDefinition');
  }

  const vsUrl = elem.binding?.valueSet;
  if (!vsUrl) {
    throw new Error('could not find valueSet url for genderIndentity');
  }

  const vs = await fetchCtsNlmNihGovValueSetFromUrl(vsUrl);

  if (vs.url !== vsUrl) {
    throw new Error(`Gender Identity ValueSet URL is ${vs.url} instead of the expected ${vsUrl} `);
  }

  return vs;
}

async function createBirthsex(templateFilename: string): Promise<ValueSet> {
  return createValueSetFromExpansion({
    templateFilename,
    includedValueSets: [
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1',
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1021.103',
    ],
  });
}

async function createDetailedEthnicity(templateFilename: string): Promise<ValueSet> {
  return createValueSetFromExpansion({
    templateFilename,
    includedValueSets: [
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.114222.4.11.877',
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1021.103',
    ],
  });
}

async function createDetailedRace(templateFilename: string): Promise<ValueSet> {
  return createValueSetFromExpansion({
    templateFilename,
    includedValueSets: [
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.1.11.14914',
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1021.103',
    ],
    excludedValueSets: ['http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.2074.1.1.3'],
  });
}

async function createEthnicityCategory(templateFilename: string): Promise<ValueSet> {
  return createValueSetFromExpansion({
    templateFilename,
    includedValueSets: [
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.114222.4.11.837',
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1021.102',
    ],
  });
}
async function createRaceCategory(templateFilename: string): Promise<ValueSet> {
  return createValueSetFromExpansion({
    templateFilename,
    includedValueSets: [
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.114222.4.11.836',
      'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1021.102',
    ],
  });
}

async function createGenderIdentity(genderIndentityExtensionSDFilename: string): Promise<ValueSet> {
  return createValueSetFromExtension(genderIndentityExtensionSDFilename);
}

async function createSex(sexExtensionSDFilename: string): Promise<ValueSet> {
  return createValueSetFromExtension(sexExtensionSDFilename);
}

async function createSimpleLanguage(templateFilename: string): Promise<ValueSet> {
  const vs = readJson(templateFilename) as ValueSet;

  const systemToConcepts: SystemToConceptList = Object.create(null);
  systemToConcepts['urn:ietf:bcp:47'] = [];
  const concepts = systemToConcepts['urn:ietf:bcp:47'];

  // See https://www.loc.gov/standards/iso639-2/ for discussion of this text file
  const inputTextFilename = path.join(INPUT_DIR, 'ISO-639-2_utf-8.txt');
  await fetchUrlContentsToFile('https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt', inputTextFilename);

  const rl = createInterface(createReadStream(inputTextFilename));
  for await (const line of rl) {
    const fields = line.split('|');

    const bibliographic = fields[0];
    const terminologic = fields[1];
    const twoLetter = fields[2];
    const english = fields[3];
    // const french = fields[4];

    const code = coalesce(twoLetter, terminologic, bibliographic);
    const display = english.split(';')[0];

    if (code === undefined || code === '') {
      console.warn('no code, skipping entry', fields);
      continue;
    }

    if (display === undefined || display === '') {
      console.warn('no display, skipping entry', fields);
      continue;
    }

    concepts.push({ code, display });
  }

  // Build the final include
  vs.compose ??= {};
  vs.compose.include = [];
  for (const [system, concepts] of Object.entries(systemToConcepts)) {
    vs.compose.include.push({ system, concept: concepts });
  }

  return vs;
}

const INPUT_DIR = resolve(__dirname, 'input');
const OUTPUT_DIR = resolve(__dirname, 'output');
async function main(): Promise<void> {
  const sourceDir = resolve('/Users/mattlong/Downloads/clean-uscore-6.1.0-package');
  if (!(await fsExtra.exists(sourceDir))) {
    throw new Error(`Input directory ${sourceDir} missing`);
  }

  await fsExtra.mkdirp(INPUT_DIR);

  await fsExtra.mkdirp(OUTPUT_DIR);
  await fsExtra.emptyDir(OUTPUT_DIR);

  const bsJson = await createBirthsex(path.join(sourceDir, 'ValueSet-birthsex.json'));
  writeJson(bsJson, path.join(OUTPUT_DIR, 'ValueSet-birthsex.json'), true);

  const deJson = await createDetailedEthnicity(path.join(sourceDir, 'ValueSet-detailed-ethnicity.json'));
  writeJson(deJson, path.join(OUTPUT_DIR, 'ValueSet-detailed-ethnicity.json'), true);

  const drJson = await createDetailedRace(path.join(sourceDir, 'ValueSet-detailed-race.json'));
  writeJson(drJson, path.join(OUTPUT_DIR, 'ValueSet-detailed-race.json'), true);

  const giJson = await createGenderIdentity(path.join(sourceDir, 'StructureDefinition-us-core-genderIdentity.json'));
  writeJson(giJson, path.join(OUTPUT_DIR, 'ValueSet-gender-identity.json'), true);

  const ecJson = await createEthnicityCategory(path.join(sourceDir, 'ValueSet-omb-ethnicity-category.json'));
  writeJson(ecJson, path.join(OUTPUT_DIR, 'ValueSet-omb-ethnicity-category.json'), true);

  const rcJson = await createRaceCategory(path.join(sourceDir, 'ValueSet-omb-race-category.json'));
  writeJson(rcJson, path.join(OUTPUT_DIR, 'ValueSet-omb-race-category.json'), true);

  const sexJson = await createSex(path.join(sourceDir, 'StructureDefinition-us-core-sex.json'));
  writeJson(sexJson, path.join(OUTPUT_DIR, 'ValueSet-sex.json'), true);

  const slJson = await createSimpleLanguage(path.join(sourceDir, 'ValueSet-simple-language.json'));
  writeJson(slJson, path.join(OUTPUT_DIR, 'ValueSet-simple-language.json'));
}

if (require.main === module) {
  dotenv.config();
  // main(process.argv.length === 3 ? process.argv[2] : 'file:medplum.config.json').catch(console.log);
  main().catch(console.error);
}
