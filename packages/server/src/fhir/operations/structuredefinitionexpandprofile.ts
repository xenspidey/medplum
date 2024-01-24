import { allOk, badRequest, isPopulated, Operator } from '@medplum/core';
import { Bundle, BundleEntry, StructureDefinition } from '@medplum/fhirtypes';
import { Request, Response } from 'express';
import { getConfig } from '../../config';
import { getAuthenticatedContext } from '../../context';
import { Repository } from '../repo';
import { sendResponse } from '../response';
import { sendOutcome } from '../outcomes';

/**
 * Handles a StructureDefinition profile expansion request.
 * Searches for all extensions related to the profile.
 * @param req - The HTTP request.
 * @param res - The HTTP response.
 */
export async function structureDefinitionExpandProfileHandler(req: Request, res: Response): Promise<void> {
  const ctx = getAuthenticatedContext();
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    sendOutcome(res, badRequest('Profile url not specified'));
    return;
  }

  //const profile = await ctx.repo.loadProfile(url);
  const profile = await fetchProfileByUrl(ctx.repo, url);

  if (!profile) {
    sendOutcome(res, badRequest('Profile not found'));
    return;
  }

  const sds = await loadNestedStructureDefinitions(ctx.repo, profile);

  const bundle = bundleResults([profile, ...sds]);

  await sendResponse(res, allOk, bundle);
}

async function fetchProfileByUrl(repo: Repository, url: string): Promise<StructureDefinition | undefined> {
  return repo.searchOne<StructureDefinition>({
    resourceType: 'StructureDefinition',
    filters: [
      {
        code: 'url',
        operator: Operator.EQUALS,
        value: url,
      },
    ],
    sortRules: [
      {
        code: 'version',
        descending: true,
      },
    ],
  });
}

async function loadNestedStructureDefinitions(
  repo: Repository,
  profile: StructureDefinition
): Promise<StructureDefinition[]> {
  const profilesUrlsToLoad: string[] = [];

  if (isPopulated(profile.snapshot)) {
    for (const element of profile.snapshot.element) {
      const profiles = element.type
        ?.map((t) => t.profile)
        .flat()
        .filter((p): p is string => p !== undefined);

      if (isPopulated(profiles)) {
        for (const subProfile of profiles) {
          if (subProfile !== undefined) {
            profilesUrlsToLoad.push(subProfile);
          }
        }
      }
    }
  }
  const promises: ReturnType<typeof fetchProfileByUrl>[] = profilesUrlsToLoad.map((url) =>
    fetchProfileByUrl(repo, url)
  );
  const results = await Promise.all(promises);
  const response = [];
  for (const result of results) {
    if (result === undefined) {
      continue;
    }

    response.push(result);

    // recursive loop
    const nested = await loadNestedStructureDefinitions(repo, result);
    response.push(...nested);
  }

  return response;
}

function bundleResults(profiles: StructureDefinition[]): Bundle<StructureDefinition> {
  const entry: BundleEntry<StructureDefinition>[] = [];

  for (const profile of profiles) {
    entry.push({
      fullUrl: `${getConfig().baseUrl}fhir/R4/StructureDefinition/${profile.id}`,
      resource: profile,
    });
  }

  return {
    resourceType: 'Bundle',
    type: 'searchset',
    entry,
  };
}
