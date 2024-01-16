import { Resource } from '@medplum/fhirtypes';
import { getTypedPropertyValue, toTypedValue } from '../fhirpath/utils';
import { isResource, TypedValue } from '../types';
import { arrayify, isLowerCase } from '../utils';
import { getDataType, InternalTypeSchema } from './types';

export interface ResourceVisitor {
  onEnterObject?: (path: string, value: TypedValue, schema: InternalTypeSchema) => void;
  onExitObject?: (path: string, value: TypedValue, schema: InternalTypeSchema) => void;
  onEnterResource?: (path: string, value: TypedValue, schema: InternalTypeSchema) => void;
  onExitResource?: (path: string, value: TypedValue, schema: InternalTypeSchema) => void;
  visitProperty?: (
    parent: TypedValue,
    key: string,
    path: string,
    propertyValues: (TypedValue | TypedValue[] | undefined)[],
    schema: InternalTypeSchema
  ) => void;
}

export function crawlResource(
  resource: Resource,
  visitor: ResourceVisitor,
  schema?: InternalTypeSchema,
  initialPath?: string
): void {
  new ResourceCrawler(resource, visitor, schema, initialPath).crawl();
}

class ResourceCrawler {
  private readonly rootResource: Resource;
  private readonly visitor: ResourceVisitor;
  private readonly schema: InternalTypeSchema;
  private readonly initialPath: string;

  constructor(rootResource: Resource, visitor: ResourceVisitor, schema?: InternalTypeSchema, initialPath?: string) {
    this.rootResource = rootResource;
    this.visitor = visitor;

    if (schema) {
      this.schema = schema;
    } else {
      this.schema = getDataType(rootResource.resourceType);
    }

    if (initialPath) {
      this.initialPath = initialPath;
    } else {
      this.initialPath = rootResource.resourceType;
    }
  }

  crawl(): void {
    this.crawlObject(toTypedValue(this.rootResource), this.schema, this.initialPath);
  }

  private crawlObject(obj: TypedValue, schema: InternalTypeSchema, path: string): void {
    const objIsResource = isResource(obj.value);

    if (objIsResource && this.visitor.onEnterResource) {
      this.visitor.onEnterResource(path, obj, schema);
    }

    if (this.visitor.onEnterObject) {
      this.visitor.onEnterObject(path, obj, schema);
    }

    for (const key of Object.keys(schema.elements)) {
      this.crawlProperty(obj, key, schema, `${path}.${key}`);
    }

    if (this.visitor.onExitObject) {
      this.visitor.onExitObject(path, obj, schema);
    }

    if (objIsResource && this.visitor.onExitResource) {
      this.visitor.onExitResource(path, obj, schema);
    }
  }

  private crawlProperty(parent: TypedValue, key: string, schema: InternalTypeSchema, path: string): void {
    const propertyValues = getNestedProperty(parent, key);
    if (this.visitor.visitProperty) {
      this.visitor.visitProperty(parent, key, path, propertyValues, schema);
    }

    for (const propertyValue of propertyValues) {
      if (propertyValue) {
        for (const value of arrayify(propertyValue) as TypedValue[]) {
          this.crawlPropertyValue(value, path);
        }
      }
    }
  }

  private crawlPropertyValue(value: TypedValue, path: string): void {
    if (!isLowerCase(value.type.charAt(0))) {
      // Recursively crawl as the expected data type
      const type = getDataType(value.type);
      this.crawlObject(value, type, path);
    }
  }
}

export function getNestedProperty(
  value: TypedValue,
  key: string,
  profileUrl?: string
): (TypedValue | TypedValue[] | undefined)[] {
  if (key === '$this') {
    return [value];
  }
  const [firstProp, ...nestedProps] = key.split('.');
  let propertyValues = [getTypedPropertyValue(value, firstProp, profileUrl)];
  for (const prop of nestedProps) {
    const next = [];
    for (const current of propertyValues) {
      if (Array.isArray(current)) {
        for (const element of current) {
          next.push(getTypedPropertyValue(element, prop, profileUrl));
        }
      } else if (current !== undefined) {
        next.push(getTypedPropertyValue(current, prop, profileUrl));
      }
    }
    propertyValues = next;
  }
  return propertyValues;
}
