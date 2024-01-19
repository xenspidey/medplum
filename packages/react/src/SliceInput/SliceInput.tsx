import { Group, Stack } from '@mantine/core';
import { InternalSchemaElement, getPropertyDisplayName, isEmpty, isPopulated } from '@medplum/core';
import { OperationOutcome } from '@medplum/fhirtypes';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ElementsContext, ElementsContextType, buildElementsContext } from '../ElementsInput/ElementsInput.utils';
import { FormSection } from '../FormSection/FormSection';
import classes from '../ResourceArrayInput/ResourceArrayInput.module.css';
import { ElementDefinitionTypeInput } from '../ResourcePropertyInput/ResourcePropertyInput';
import { ArrayAddButton } from '../buttons/ArrayAddButton';
import { ArrayRemoveButton } from '../buttons/ArrayRemoveButton';
import { killEvent } from '../utils/dom';
import { SupportedSliceDefinition } from './SliceInput.utils';

export type SliceInputProps = Readonly<{
  path: string;
  slice: SupportedSliceDefinition;
  property: InternalSchemaElement;
  defaultValue: any[];
  onChange: (newValue: any[]) => void;
  outcome?: OperationOutcome;
  testId?: string;
}>;

function maybeWrapWithContext(contextValue: ElementsContextType | undefined, contents: JSX.Element): JSX.Element {
  if (contextValue) {
    return <ElementsContext.Provider value={contextValue}>{contents}</ElementsContext.Provider>;
  }

  return contents;
}

export function SliceInput(props: SliceInputProps): JSX.Element | null {
  const { slice, property } = props;
  const defaultValueRef = useRef(props.defaultValue.map((v) => v ?? {}));
  const [values, setValues] = useState<any[]>(() => {
    return props.defaultValue.map((v) => v ?? {});
  });

  useEffect(() => {
    console.log(
      `SliceInput[${props.path}]`,
      isPopulated(slice.typeSchema?.elements),
      isPopulated(slice.elements),
      defaultValueRef.current
    );
  }, [props.path, slice.elements, slice.typeSchema?.elements]);

  const sliceType = slice.typeSchema?.type ?? slice.type[0].code;
  const sliceElements = slice.typeSchema?.elements ?? slice.elements;

  const parentElementsContextValue = useContext(ElementsContext);

  const lastInputsRef = useRef<any[]>([]);
  const contextValue = useMemo(() => {
    if (lastInputsRef.current.length === 0) {
      lastInputsRef.current = [parentElementsContextValue, props.path, sliceElements, sliceType];
      // console.log('whyChange FIRST', JSON.stringify(lastInputsRef.current));
    } else {
      const things = [parentElementsContextValue, props.path, sliceElements, sliceType];
      const result = [];
      for (let i = 0; i < things.length; i++) {
        const thing = things[i];
        const lastThing = lastInputsRef.current[i];
        if (!Object.is(thing, lastThing)) {
          result.push([lastThing, thing]);
        } else {
          result.push(' ');
        }
      }
      console.log('whyChange ', result);
    }
    if (isPopulated(sliceElements)) {
      return buildElementsContext({
        defaultValue: defaultValueRef.current,
        parentContext: parentElementsContextValue,
        elements: sliceElements,
        parentPath: props.path,
        parentType: sliceType,
        debugMode: true,
      });
    }
    console.assert(false, 'Expected sliceElements to always be populated', slice.name);
    return undefined;
  }, [parentElementsContextValue, props.path, slice.name, sliceElements, sliceType]);

  function setValuesWrapper(newValues: any[]): void {
    setValues(newValues);
    if (props.onChange) {
      props.onChange(newValues);
    }
  }

  const required = slice.min > 0;

  // this is a bit of a hack targeted at nested extensions; indentation would ideally be controlled elsewhere
  // e.g. USCorePatientProfile -> USCoreEthnicityExtension -> {ombCategory, detailed, text}
  const indentedStack = isEmpty(slice.elements);
  const propertyDisplayName = getPropertyDisplayName(slice.name);
  return maybeWrapWithContext(
    contextValue,
    <FormSection
      title={propertyDisplayName}
      description={slice.definition}
      withAsterisk={required}
      fhirPath={`${property.path}:${slice.name}`}
      testId={props.testId}
    >
      <Stack className={indentedStack ? classes.indented : undefined}>
        {values.map((value, valueIndex) => {
          return (
            <Group key={`${valueIndex}-${values.length}`} wrap="nowrap">
              <div style={{ flexGrow: 1 }}>
                <ElementDefinitionTypeInput
                  elementDefinitionType={slice.type[0]}
                  name={slice.name}
                  defaultValue={value}
                  onChange={(newValue) => {
                    const newValues = [...values];
                    newValues[valueIndex] = newValue;
                    setValuesWrapper(newValues);
                  }}
                  outcome={props.outcome}
                  min={slice.min}
                  max={slice.max}
                  binding={slice.binding}
                  path={props.path}
                />
              </div>
              {values.length > slice.min && (
                <ArrayRemoveButton
                  propertyDisplayName={propertyDisplayName}
                  testId={props.testId && `${props.testId}-remove-${valueIndex}`}
                  onClick={(e: React.MouseEvent) => {
                    killEvent(e);
                    const newValues = [...values];
                    newValues.splice(valueIndex, 1);
                    setValuesWrapper(newValues);
                  }}
                />
              )}
            </Group>
          );
        })}
        {values.length < slice.max && (
          <Group wrap="nowrap" style={{ justifyContent: 'flex-start' }}>
            <ArrayAddButton
              propertyDisplayName={propertyDisplayName}
              onClick={(e: React.MouseEvent) => {
                killEvent(e);
                const newValues = [...values, undefined];
                setValuesWrapper(newValues);
              }}
              testId={props.testId && `${props.testId}-add`}
            />
          </Group>
        )}
      </Stack>
    </FormSection>
  );
}
