import {
  Anchor,
  Badge,
  Button,
  Grid,
  Group,
  Modal,
  NativeSelect,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { createReference } from '@medplum/core';
import { Condition, Encounter, Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react-hooks';
import { Fragment, useCallback, useState } from 'react';
import { CodeableConceptDisplay } from '../CodeableConceptDisplay/CodeableConceptDisplay';
import { Form } from '../Form/Form';
import { killEvent } from '../utils/dom';

export interface ProblemListProps {
  readonly patient: Patient;
  readonly encounter?: Encounter;
  readonly problems: Condition[];
}

export function ProblemList(props: ProblemListProps): JSX.Element {
  const medplum = useMedplum();
  const { patient, encounter } = props;
  const [problems, setProblems] = useState<Condition[]>(props.problems);
  const [opened, { open, close }] = useDisclosure(false);

  const handleSubmit = useCallback(
    (formData: Record<string, string>) => {
      medplum
        .createResource<Condition>({
          resourceType: 'Condition',
          subject: createReference(patient),
          encounter: encounter ? createReference(encounter) : undefined,
          code: { coding: [{ code: formData.problem, display: formData.problem }] },
          onsetDateTime: formData.onset ? formData.onset : undefined,
        })
        .then((newProblem) => {
          setProblems([...problems, newProblem]);
          close();
        })
        .catch(console.error);
    },
    [medplum, patient, encounter, problems, close]
  );

  return (
    <>
      <Group justify="space-between">
        <Text fz="md" fw={700}>
          Problem List
        </Text>
        <Anchor
          href="#"
          onClick={(e) => {
            killEvent(e);
            open();
          }}
        >
          + Add
        </Anchor>
      </Group>
      {problems.length > 0 ? (
        <Grid gutter="xs">
          {problems.map((problem) => (
            <Fragment key={problem.id}>
              <Grid.Col span={2}>{problem.onsetDateTime?.substring(0, 4)}</Grid.Col>
              <Grid.Col span={10}>
                <Badge key={problem.id} variant="light" maw="100%">
                  <CodeableConceptDisplay value={problem.code} />
                </Badge>
              </Grid.Col>
            </Fragment>
          ))}
        </Grid>
      ) : (
        <Text>(none)</Text>
      )}
      <Modal opened={opened} onClose={close} title="Add Problem">
        <Form onSubmit={handleSubmit}>
          <Stack>
            <TextInput name="problem" label="Problem" data-autofocus={true} autoFocus required />
            <TextInput name="onset" label="Dx Date" type="date" required />
            <NativeSelect name="status" label="Status" data={['active']} />
            <Textarea name="notes" label="Notes" />
            <Group justify="flex-end" gap={4} mt="md">
              <Button type="submit">Save</Button>
            </Group>
          </Stack>
        </Form>
      </Modal>
    </>
  );
}
