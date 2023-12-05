function getApiKey(): string {
  if (!process.env['UMLS_API_KEY']) {
    throw new Error('UMLS_API_KEY env var missing');
  }
  return process.env['UMLS_API_KEY'];
}

export async function fetchCtsNlmNihGovValueSet(oid: string, release?: string): Promise<any> {
  // const URL = 'https://vsac.nlm.nih.gov/vsac/svs/RetrieveMultipleValueSets'
  // const URL = 'https://vsac.nlm.nih.gov/vsac/svs/RetrieveValueSet'
  const URL = `https://cts.nlm.nih.gov/fhir/ValueSet/${oid}/$expand`;

  const params = new URLSearchParams({});

  if (release) {
    params.append('release', release);
  }

  const auth = btoa(`:${getApiKey()}`);
  const resp = await fetch(URL, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });

  return resp.json();
}

export async function fetchCtsNlmNihGovValueSetFromUrl(url: string): Promise<any> {
  const parts = url.split('/');
  const oid = parts[parts.length - 1];

  if (!oid) {
    throw new Error(`Could not find oid in URL ${url}`);
  }

  return fetchCtsNlmNihGovValueSet(oid);
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error('Specify ValueSet oid');
  }

  const oid = process.argv[2];

  await fetchCtsNlmNihGovValueSet(oid);
}

if (require.main === module) {
  main().catch(console.error);
}
