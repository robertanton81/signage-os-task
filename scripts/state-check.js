// Result check of the development stack's MongoDB (compose spec, amendment of 2026-09-15 to
// decision 25). A mongosh script, run inside the MongoDB container so that the credentials come
// from the container's own environment and never reach the host command line:
//
//   docker compose exec -T mongodb sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin telemetry /dev/stdin' < scripts/state-check.js
//
// Run it on a quiet system: emulator stopped and `telemetry.events` empty. While messages move, an
// event can be stored before its state write, and check 3 reports a mismatch that is not one.
// Prints one PASS or FAIL line per check and exits 1 when any check failed.

const events = db.events;

// Section fields that are not part of the event payload (packages/shared/src/documents.ts, SectionMeta).
const SECTION_META_FIELDS = 4;

// 1. The unique index that stores a duplicate once (consistency spec, decision 9a), on exactly the
//    identity fields in this order (packages/shared/src/collections.ts, EVENTS_IDENTITY_INDEX).
const IDENTITY_INDEX_KEY = JSON.stringify({ deviceId: 1, sessionId: 1, seq: 1 });
const identityIndex = events.getIndexes().find((index) => index.name === 'identity_unique');

// 2. No identity (deviceId, sessionId, seq) is stored twice.
const duplicateIdentities = events
  .aggregate([
    { $group: { _id: { d: '$deviceId', s: '$sessionId', q: '$seq' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: 'n' },
  ])
  .toArray();

// 3. Newest wins: each state section is the newest stored event of its type, by (sessionId, seq),
//    with that event's payload and occurredAt and no other field. receivedAt is not compared: two
//    copies of one message carry different receipt times, and either copy may write the section.
const staleSections = events
  .aggregate(
    [
      { $sort: { deviceId: 1, type: 1, sessionId: -1, seq: -1 } },
      {
        $group: {
          _id: { deviceId: '$deviceId', type: '$type' },
          sessionId: { $first: '$sessionId' },
          seq: { $first: '$seq' },
          occurredAt: { $first: '$occurredAt' },
          payload: { $first: '$payload' },
        },
      },
      {
        $lookup: {
          from: 'device_state',
          localField: '_id.deviceId',
          foreignField: '_id',
          as: 'state',
        },
      },
      {
        $set: {
          stored: {
            $ifNull: [{ $getField: { field: '$_id.type', input: { $first: '$state' } } }, {}],
          },
        },
      },
      {
        $set: {
          matches: {
            $and: [
              { $eq: ['$stored.sessionId', '$sessionId'] },
              { $eq: ['$stored.seq', '$seq'] },
              { $eq: ['$stored.occurredAt', '$occurredAt'] },
              {
                $eq: [
                  { $size: { $objectToArray: '$stored' } },
                  { $add: [{ $size: { $objectToArray: '$payload' } }, SECTION_META_FIELDS] },
                ],
              },
              {
                $allElementsTrue: [
                  {
                    $map: {
                      input: { $objectToArray: '$payload' },
                      as: 'field',
                      in: {
                        $eq: [{ $getField: { field: '$$field.k', input: '$stored' } }, '$$field.v'],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      { $match: { matches: false } },
      {
        $project: {
          _id: 0,
          device: '$_id.deviceId',
          type: '$_id.type',
          newest: { sessionId: '$sessionId', seq: '$seq' },
          stored: { sessionId: '$stored.sessionId', seq: '$stored.seq' },
        },
      },
    ],
    { allowDiskUse: true },
  )
  .toArray();

// 4. One alert per stored error diagnostic, no more and no fewer (consistency spec, decision 17):
//    every error diagnostic has the alert of its own identity, and there are no other alerts.
const errorDiagnostics = events.countDocuments({ type: 'diagnostic', 'payload.severity': 'error' });
const alerts = db.alerts.countDocuments({});
const diagnosticsWithoutAlert = events
  .aggregate([
    { $match: { type: 'diagnostic', 'payload.severity': 'error' } },
    {
      $lookup: {
        from: 'alerts',
        let: { deviceId: '$deviceId', sessionId: '$sessionId', seq: '$seq' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$deviceId', '$$deviceId'] },
                  { $eq: ['$sessionId', '$$sessionId'] },
                  { $eq: ['$seq', '$$seq'] },
                ],
              },
            },
          },
        ],
        as: 'alert',
      },
    },
    { $match: { alert: { $size: 0 } } },
    { $count: 'n' },
  ])
  .toArray();
const missingAlerts = diagnosticsWithoutAlert[0]?.n ?? 0;

const results = [
  {
    name: 'unique index on (deviceId, sessionId, seq)',
    ok: identityIndex?.unique === true && JSON.stringify(identityIndex.key) === IDENTITY_INDEX_KEY,
    detail: JSON.stringify(identityIndex?.key ?? null),
  },
  {
    name: 'no duplicate events',
    ok: duplicateIdentities.length === 0,
    detail: `duplicated identities: ${duplicateIdentities[0]?.n ?? 0}`,
  },
  {
    name: 'every state section = newest event of its type',
    ok: staleSections.length === 0,
    detail: `mismatches: ${staleSections.length} ${JSON.stringify(staleSections.slice(0, 3))}`,
  },
  {
    name: 'one alert per error diagnostic',
    ok: missingAlerts === 0 && alerts === errorDiagnostics,
    detail: `alerts: ${alerts}, error diagnostics: ${errorDiagnostics}, without their alert: ${missingAlerts}`,
  },
];

print(`devices: ${db.device_state.countDocuments({})}, events: ${events.countDocuments({})}`);
for (const { name, ok, detail } of results) {
  print(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}
const failed = results.filter(({ ok }) => !ok).length;
print(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
if (failed > 0) {
  quit(1);
}
