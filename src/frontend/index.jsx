import React, { useState, useEffect } from 'react';
import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Stack,
  Inline,
  Button,
  Heading,
  Text,
  Lozenge,
  SectionMessage,
  Spinner,
  xcss,
  Modal,
  ModalBody,
  ModalTransition,
  ModalTitle,
  ModalFooter,
  ModalHeader,
  Form,
  useForm,
  Textfield,
  Label,
  TextArea,
  Link,
} from '@forge/react';
import { jsPDF } from 'jspdf';

import {
  generateEpicTestArtifacts,
  createSubtasksFromPack,
  generateEpicLevelTestCase,
  createEpicTestCaseTask,
} from '../utils/utility';

const gap6 = xcss({ gap: 'space.100' });
const gap10 = xcss({ gap: 'space.200' });

const card = xcss({
  borderRadius: 'border.radius.200',
  backgroundColor: 'elevation.surface.raised',
  boxShadow: 'elevation.shadow.raised',
  padding: 'space.200',
});

const softCard = xcss({
  borderRadius: 'border.radius.100',
  backgroundColor: 'elevation.surface.sunken',
  padding: 'space.150',
});

const muted = xcss({ color: 'color.text.subtlest' });

const toLines = (val) => {
  if (val == null) return [];
  if (Array.isArray(val)) {
    // flatten + stringify
    return val.flatMap(toLines)
      .map(x => (typeof x === 'string' ? x : String(x)))
      .map(s => s.trim())
      .filter(Boolean);
  }
  if (typeof val === 'string') {
    return val.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  if (typeof val === 'object') {
    // common shapes: {text}, {value}, {items:[...]}, or random object
    if (typeof val.text === 'string') return toLines(val.text);
    if (typeof val.value === 'string') return toLines(val.value);
    if (Array.isArray(val.items)) return toLines(val.items);
    return toLines(Object.values(val));
  }
  return [String(val)];
};

const asBullets = (val) => {
  const lines = toLines(val);
  return lines.length ? `• ${lines.join('\n• ')}` : '';
};

const asNumbers = (val) => {
  const lines = toLines(val);
  return lines.map((s, i) => `${i + 1}. ${s}`).join('\n');
};


// 🔹 Modal Form
const FormInModal = ({ closeModal, pack }) => {
  const { handleSubmit, getFieldId, register } = useForm();
  const [isEditing, setIsEditing] = useState(false);

  if (!pack) return null;
  const suggestion = pack.suggestions?.[0] || {}; // pehla suggestion

  const onSubmit = handleSubmit((data) => {
    console.log('Form Data:', data);
    setIsEditing(false);
  });

  return (
    <Form onSubmit={onSubmit}>
      <ModalHeader>
        <ModalTitle>{pack.parentKey} - {suggestion.title}</ModalTitle>
      </ModalHeader>
    
      <ModalBody>
        <Label labelFor={getFieldId('title')}>Title</Label>
        <Textfield
          {...register('title')}
          isDisabled={!isEditing}
          defaultValue={String(suggestion.title ?? '')}
        />
        <Label labelFor={getFieldId('environment')}>Environment</Label>
        <Textfield
          {...register('environment')}
          isDisabled={!isEditing}
          defaultValue={String(suggestion.environment ?? '')}
        />
        <Label>Description</Label>
        <TextArea
          defaultValue={String(suggestion.description ?? '')}
          isDisabled={!isEditing}
        />

        <Label>Preconditions</Label>
        <TextArea
          defaultValue={asBullets(suggestion.preconditions)}
          isDisabled={!isEditing}
        />

        <Label>Steps</Label>
        <TextArea
          defaultValue={asNumbers(suggestion.testSteps)}
          isDisabled={!isEditing}
        />

        <Label>Expected Result</Label>
        <TextArea
          defaultValue={asBullets(suggestion.expectedResult)}
          isDisabled={!isEditing}
        />

        <Label>Actual Result</Label>
        <TextArea
          placeholder="(blank during planning; tester fills later)"
          isDisabled={!isEditing}
        />
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" onClick={closeModal}>
          Close
        </Button>
        {isEditing ? (
          <Button appearance="primary" type="submit">
            Save
          </Button>
        ) : (
          <Button appearance="primary" onClick={() => setIsEditing(true)}>
            Edit
          </Button>
        )}
      </ModalFooter>
    </Form>
  );
};


const App = () => {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [data, setData] = useState(null);

  const [creatingKey, setCreatingKey] = useState(null);
  const [results, setResults] = useState({});
  const [creatingEpic, setCreatingEpic] = useState(false);
  const [epicResult, setEpicResult] = useState(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedPack, setSelectedPack] = useState(null);  // jo pack select hua

  // NEW: show all-created items after "Create all test cases"
  const [isAllModalOpen, setIsAllModalOpen] = useState(false);
  const [allCreated, setAllCreated] = useState([]); // [{key, parentKey}]
  const [allErrors, setAllErrors] = useState([]); // [{message, parentKey}]

  const [siteUrl, setSiteUrl] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const url = await invoke('getSiteUrl');
        setSiteUrl(url || '');
      } catch (e) {
        console.log('getSiteUrl failed', e);
      }
    })();
  }, []);
  // Generate
  const handleGenerate = async () => {
    setErr('');
    setData(null);
    setResults({});
    setCreatingKey(null);
    setEpicResult(null);
    setAllCreated([]);
    setAllErrors([]);
    setIsAllModalOpen(false);

    setLoading(true);
    try {
      const result = await generateEpicTestArtifacts();
      console.log("result>>", result)
      setData(result);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  // Create subtask pack
  const handleCreatePack = async (pack) => {
    if (!pack || !pack.parentKey) return;
    setErr('');
    setCreatingKey(pack.parentKey);
    try {
      const res = await createSubtasksFromPack(pack);
      console.log("resssss>>", res);
      setResults((prev) => ({ ...prev, [pack.parentKey]: res }));
    } catch (e) {
      setResults((prev) => ({
        ...prev,
        [pack.parentKey]: { created: [], errors: [String(e?.message || e)] },
      }));
    } finally {
      setCreatingKey(null);
    }
  };

  // Create Epic test case
  const handleCreateEpicTest = async () => {
    try {
      setErr('');
      setEpicResult(null);
      setCreatingEpic(true);

      const { epic, suggestion } = await generateEpicLevelTestCase();
      if (!suggestion) throw new Error('No suggestion generated for Epic');

      const res = await createEpicTestCaseTask({
        epicKey: epic.key,
        suggestion,
        linkTypeName: 'Relates',
      });
      setEpicResult(res);
    } catch (e) {
      setEpicResult({ created: [], errors: [String(e?.message || e)] });
    } finally {
      setCreatingEpic(false);
    }
  };

  // PDF Download 
  const handleDownloadPDF = () => {
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text('Impact Analysis', 20, 20);
    let y = 30;
    if (data?.impact) {
      doc.setFontSize(14);
      doc.setFont("helvetica", "bold");
      doc.text("Impact Areas:", 20, y);
      y += 8;
      doc.setFont("helvetica", "normal");
      doc.text(`${data.impact.impactAreas?.join(', ') || 'None'}`, 20, y);
      y += 12;

      if (data.impact.riskAssessment?.length) {
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text("Risk Assessment:", 20, y);
        y += 8;
        doc.setFont("helvetica", "normal");
        data.impact.riskAssessment.forEach((r) => {
          doc.text(`${r.area} — ${r.risk} (${r.reason})`, 20, y);
          y += 10;
        });
        y += 5;
      }

      if (data.impact.regressionHotspots?.length) {
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text("Regression Hotspots:", 20, y);
        y += 8;
        doc.setFont("helvetica", "normal");
        data.impact.regressionHotspots.forEach((h) => {
          doc.text(`${h}`, 20, y);
          y += 10;
        });
        y += 5;
      }

      if (data.impact.dataConcerns?.length) {
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text("Data Concerns:", 20, y);
        y += 8;
        doc.setFont("helvetica", "normal");
        data.impact.dataConcerns.forEach((c) => {
          doc.text(`${c}`, 20, y);
          y += 10;
        });
        y += 5;
      }

      if (data.impact.mitigations?.length) {
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text("Mitigations:", 20, y);
        y += 8;
        doc.setFont("helvetica", "normal");
        data.impact.mitigations.forEach((m) => {
          doc.text(`${m}`, 20, y);
          y += 10;
        });
        y += 5;
      }

      if (data.impact.smokeSuite?.length) {
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        doc.text("Smoke Suite:", 20, y);
        y += 8;
        doc.setFont("helvetica", "normal");
        data.impact.smokeSuite.forEach((s) => {
          doc.text(`${s}`, 20, y);
          y += 10;
        });
      }
    }

    doc.save('impact_analysis.pdf');
  };

  const riskToAppearance = (risk) => {
    switch ((risk || '').toLowerCase()) {
      case 'high':
        return 'removed';
      case 'medium':
        return 'inprogress';
      case 'low':
        return 'success';
      default:
        return 'default';
    }
  };

  // Create ALL test cases and SHOW ALL created ones
  const handleCreateAll = async () => {
    if (!data?.subtaskPacks?.length) return;

    setErr('');
    setCreatingKey('__ALL__');

    const newResults = { ...results };
    const createdAgg = [];
    const errorsAgg = [];

    for (const pack of data.subtaskPacks) {
      try {
        const res = await createSubtasksFromPack(pack);
        newResults[pack.parentKey] = res;

        if (Array.isArray(res?.created)) {
          res.created.forEach((c) => {
            const key = typeof c === 'string' ? c : c?.key || c?.id || '';
            if (key) createdAgg.push({ key, parentKey: pack.parentKey });
          });
        }

        if (Array.isArray(res?.errors) && res.errors.length) {
          res.errors.forEach((e) =>
            errorsAgg.push({ message: String(e), parentKey: pack.parentKey })
          );
        }
      } catch (e) {
        const msg = String(e?.message || e);
        newResults[pack.parentKey] = { created: [], errors: [msg] };
        errorsAgg.push({ message: msg, parentKey: pack.parentKey });
      }
    }

    setResults(newResults);
    setAllCreated(createdAgg);
    setAllErrors(errorsAgg);
    setIsAllModalOpen(true);
    setCreatingKey(null);
  };

  return (
    <Box
      xcss={xcss({
        backgroundColor: 'color.background.accent.white.subtlest',
        color: 'color.text',
        padding: 'space.200',
        minHeight: '100vh',
      })}
    >
      <Stack xcss={gap10}>
        {/* Header */}
        <Inline alignBlock="center" spread="space-between">

          <Inline space="space.400" xcss={{ marginBottom: 'space.200' }}>
            <Button appearance="primary" onClick={handleGenerate} isDisabled={loading}>
              {loading ? 'Generating…' : 'Generate'}
            </Button>

            <Button appearance="primary" onClick={handleCreateAll} isDisabled={creatingKey !== null}>
              {creatingKey === '__ALL__' ? 'Creating all…' : 'Create all test cases'}
            </Button>

            <Button appearance="primary" onClick={handleCreateEpicTest} isDisabled={creatingEpic}>
              {creatingEpic ? 'Creating…' : 'Create Epic TestCase'}
            </Button>
          </Inline>
          {loading && <Spinner label="Loading" size="medium" />}
        </Inline>

        {/* Error */}
        {err && (
          <SectionMessage title="Error" appearance="error">
            <Text>{err}</Text>
          </SectionMessage>
        )}

        {/*  Epic Info Section (Dynamic) */}
        {data?.epic && (
          <Box xcss={card}>
            <Heading size="medium">
              Epic: {data?.epic?.key} — {data?.epic?.summary}
            </Heading>

            <Text xcss={muted}>
              Children: {data?.counts?.totalChildren}{' '}
              {data?.counts?.byType &&
                `| ${Object.entries(data.counts.byType)
                  .map(([type, num]) => `${type}: ${num}`)
                  .join(', ')}`}
            </Text>
          </Box>

        )}

        {/* Subtask Packs */}
        {data?.subtaskPacks?.map((pack) => {
          const r = results[pack.parentKey];
          return (
            <Box key={pack.parentKey} xcss={card}>
              <Stack xcss={gap10}>

                <Inline alignBlock="center" spread="space-between">
                  {/* Left side heading */}
                  <Heading size="small">{pack.parentKey}</Heading>

                  {/* Right side buttons group */}
                  <Inline alignBlock="center" space="space.100">
                    <Button appearance="primary" onClick={() => {
                      setSelectedPack(pack);  // current pack set
                      setIsModalOpen(true)
                    }}>
                      View Details
                    </Button>
                    <Button
                      appearance="primary"
                      onClick={() => handleCreatePack(pack)}
                      isDisabled={creatingKey !== null}
                    >
                      {creatingKey === pack.parentKey ? 'Creating…' : 'Create TestCase'}
                    </Button>
                  </Inline>
                </Inline>

                {/* Suggestions */}
                <Stack xcss={gap6}>
                  {pack.suggestions?.slice(0, 3).map((s, i) => (
                    <Box key={i} xcss={softCard}>
                      <Inline alignBlock="center" spread="space-between">
                        <Text>{s.title}</Text>
                        <Lozenge appearance={riskToAppearance(s.priority)}>
                          {s.priority || 'Medium'}
                        </Lozenge>
                      </Inline>
                      {s.description && <Text xcss={muted}>{s.description}</Text>}
                    </Box>
                  ))}
                  {pack.suggestions?.length > 3 && (
                    <Text>…and {pack.suggestions.length - 3} more</Text>
                  )}
                </Stack>

                {/* Results per-pack */}
                {r && (
                  <Box xcss={softCard}>
                    <Heading size="xsmall">Result</Heading>
                    <Stack xcss={gap6}>
                      <Stack>
                        {r.created?.length > 0 && (
                          <Stack>
                            <Text>Created {r.created.length} sub-task(s):</Text>

                            {r.created.map((c, i) => {
                              const key = typeof c === 'string' ? c : c?.key || c?.id || `#${i + 1}`;

                              return (
                                <Text as="span">
                                  <Link
                                    key={key}
                                    href={siteUrl ? `${siteUrl}/browse/${key}` : `#/browse/${key}`}


                                    openNewTab={true}
                                    appearance="link"
                                  >
                                    {key}
                                  </Link>
                                </Text>

                              );
                            })}
                          </Stack>
                        )}
                      </Stack>

                      {r.errors?.length > 0 && (
                        <Stack>
                          <Text>Errors:</Text>
                          {r.errors.map((e, i) => (
                            <Text key={i}>• {String(e)}</Text>
                          ))}
                        </Stack>
                      )}
                      {!r.created?.length && !r.errors?.length && <Text xcss={muted}>—</Text>}
                    </Stack>
                  </Box>
                )}
              </Stack>
            </Box>
          );
        })}

        {/* Epic Result */}
        {epicResult && (
          <Box xcss={card}>
            <Heading size="small">Epic Test Case Result</Heading>
            <Stack>
              {epicResult.created?.length > 0 && (
                <Stack>
                  <Text>Created {epicResult.created.length} issue(s):</Text>
                  {epicResult.created.map((c, i) => {
                    const key = typeof c === 'string' ? c : c?.key || c?.id || `#${i + 1}`;
                    return <Text key={key}>• {key}</Text>;
                  })}
                </Stack>
              )}
              {epicResult.errors?.length > 0 && (
                <Stack>
                  <Text>Errors:</Text>
                  {epicResult.errors.map((e, i) => (
                    <Text key={i}>• {String(e)}</Text>
                  ))}
                </Stack>
              )}
            </Stack>
          </Box>
        )}

        {/* Impact Analysis Section */}
        {data?.impact && (
          <Box xcss={card}>
            <Inline alignBlock="center" spread="space-between">
              <Heading size="small">Impact Analysis</Heading>
              <Button appearance="primary" onClick={handleDownloadPDF}>
                Download PDF
              </Button>
            </Inline>

            <Box xcss={softCard}>
              <Heading size="xsmall">Impact Areas</Heading>
              <Text>{data.impact.impactAreas?.join(', ') || 'None'}</Text>
            </Box>

            {data.impact.riskAssessment?.length > 0 && (
              <Box xcss={softCard}>
                <Heading size="xsmall">Risk Assessment</Heading>
                <Stack>
                  {data.impact.riskAssessment.map((r, i) => (
                    <Text key={i}>
                      {r.area} — {r.risk} ({r.reason})
                    </Text>
                  ))}
                </Stack>
              </Box>
            )}

            {/* Data Concerns */}
            {data.impact.dataConcerns?.length > 0 && (
              <Box xcss={softCard}>
                <Heading size="xsmall">Data Concerns</Heading>
                <Stack>
                  {data.impact.dataConcerns.map((c, i) => (
                    <Text key={i}>{c}</Text>
                  ))}
                </Stack>
              </Box>
            )}

            {/* Mitigations */}
            {data.impact.mitigations?.length > 0 && (
              <Box xcss={softCard}>
                <Heading size="xsmall">Mitigations</Heading>
                <Stack>
                  {data.impact.mitigations.map((m, i) => (
                    <Text key={i}>{m}</Text>
                  ))}
                </Stack>
              </Box>
            )}

            {/* Smoke Suite */}
            {data.impact.smokeSuite?.length > 0 && (
              <Box xcss={softCard}>
                <Heading size="xsmall">Smoke Suite</Heading>
                <Stack>
                  {data.impact.smokeSuite.map((s, i) => (
                    <Text key={i}>{s}</Text>
                  ))}
                </Stack>
              </Box>
            )}
          </Box>
        )}

        {/* Existing Test-Case Edit Modal */}
        <ModalTransition>
          {isModalOpen && (
            <Modal onClose={() => setIsModalOpen(false)}>
              <FormInModal closeModal={() => setIsModalOpen(false)} pack={selectedPack} />
            </Modal>
          )}
        </ModalTransition>

        {/* NEW: Show ALL created test cases after "Create all" */}
        <ModalTransition>
          {isAllModalOpen && (
            <Modal onClose={() => setIsAllModalOpen(false)}>
              <ModalHeader>
                <ModalTitle>All Created Test Cases</ModalTitle>
              </ModalHeader>
              <ModalBody>
                {allCreated.length > 0 ? (
                  <Stack xcss={gap6}>
                    <Text>
                      Total created: {allCreated.length}
                    </Text>
                   
                    {allCreated.map((c, i) => (
                      <Text key={`${c.parentKey}-${c.key}-${i}`}>
                        <Link
                          href={siteUrl ? `${siteUrl}/browse/${c.key}` : `#/browse/${c.key}`}
                          openNewTab={true}
                          appearance="link"
                        >
                          {c.key}
                        </Link>{' '}
                        <Text xcss={muted}>(from {c.parentKey})</Text>
                      </Text>
                    ))}

                  </Stack>
                ) : (
                  <Text xcss={muted}>No test cases were created.</Text>
                )}

                {allErrors.length > 0 && (
                  <Box xcss={{ marginTop: 'space.200' }}>
                    <Heading size="xsmall">Errors</Heading>
                    <Stack xcss={gap6}>
                      {allErrors.map((e, i) => (
                        <Text key={`${e.parentKey}-err-${i}`}>
                          • {e.message} <Text xcss={muted}>(in {e.parentKey})</Text>
                        </Text>
                      ))}
                    </Stack>
                  </Box>
                )}
              </ModalBody>
              <ModalFooter>
                <Button appearance="primary" onClick={() => setIsAllModalOpen(false)}>
                  Close
                </Button>
              </ModalFooter>
            </Modal>
          )}
        </ModalTransition>
      </Stack>
    </Box>
  );
};

ForgeReconciler.render(<App />);





