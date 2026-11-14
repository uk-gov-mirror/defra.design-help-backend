import { ObjectId } from 'mongodb'

import {
  GDAD_SKILL_KEYS,
  MAX_EVIDENCE_LENGTH,
  MAX_HELPING_ROWS
} from '#/common/constants.js'

const COLLECTION = 'people'

export const PROFILE_FIELDS = [
  'name',
  'role',
  'location',
  'experience',
  'bio',
  'canHelpWith',
  'canHelpWithText',
  'developmentGoalsText',
  'projectTeam',
  'deliveryGroup',
  'linkedinProfile',
  'availabilityStatus',
  'contactEmail'
]

export class PeopleError extends Error {
  constructor(code, detail) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

export function people(db) {
  return db.collection(COLLECTION)
}

export function normaliseEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : null
}

export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function toId(value) {
  if (value instanceof ObjectId) {
    return value
  }
  if (typeof value === 'string' && ObjectId.isValid(value)) {
    return new ObjectId(value)
  }
  return null
}

export function toApiPerson(doc) {
  if (!doc) {
    return null
  }
  const {
    _id,
    managerId,
    helping,
    gdad,
    gdadScoresNotifiedAt,
    gdadScoresNotifiedById,
    ...rest
  } = doc
  return {
    id: _id.toString(),
    managerId: managerId ? managerId.toString() : null,
    helping: (helping ?? []).map((id) => id.toString()),
    gdad: apiGdad(gdad),
    gdadScoresNotifiedAt: gdadScoresNotifiedAt
      ? new Date(gdadScoresNotifiedAt).toISOString()
      : null,
    gdadScoresNotifiedById: gdadScoresNotifiedById
      ? gdadScoresNotifiedById.toString()
      : null,
    ...rest
  }
}

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null
}

function idOrNull(value) {
  return value ? value.toString() : null
}

function apiGdadPrevious(entry) {
  return {
    evidenceText: entry.evidenceText ?? null,
    evidenceUpdatedAt: isoOrNull(entry.evidenceUpdatedAt),
    evidenceUpdatedById: idOrNull(entry.evidenceUpdatedById),
    officialScore: entry.officialScore ?? null,
    scoredAt: isoOrNull(entry.scoredAt),
    scoredById: idOrNull(entry.scoredById),
    archivedAt: isoOrNull(entry.archivedAt)
  }
}

/**
 * Every skill entry always carries the full set of fields, so records saved
 * before a field existed come back with the same shape as new ones. Dates are
 * ISO strings and ids are strings (or null).
 */
function apiGdad(gdad) {
  const result = {}
  for (const key of Object.keys(gdad ?? {})) {
    const entry = gdad[key] ?? {}
    result[key] = {
      ...entry,
      evidenceText: entry.evidenceText ?? null,
      evidenceUpdatedAt: isoOrNull(entry.evidenceUpdatedAt),
      evidenceUpdatedById: idOrNull(entry.evidenceUpdatedById),
      officialScore: entry.officialScore ?? null,
      scoredAt: isoOrNull(entry.scoredAt),
      scoredById: idOrNull(entry.scoredById),
      newEvidenceText: entry.newEvidenceText ?? null,
      newEvidenceUpdatedAt: isoOrNull(entry.newEvidenceUpdatedAt),
      newEvidenceUpdatedById: idOrNull(entry.newEvidenceUpdatedById),
      previous: (entry.previous ?? []).map(apiGdadPrevious)
    }
  }
  return result
}

function emptyProfileFields() {
  return {
    name: null,
    role: null,
    location: null,
    experience: null,
    bio: null,
    canHelpWith: [],
    canHelpWithText: null,
    developmentGoalsText: null,
    projectTeam: null,
    deliveryGroup: null,
    linkedinProfile: null,
    availabilityStatus: 'Some capacity',
    contactEmail: null
  }
}

/**
 * The prototype's slug generation collided on duplicate names; suffix with a
 * counter so every person keeps a stable, unique URL.
 */
async function ensureUniqueSlug(db, name, excludeId) {
  const base = slugify(name)
  if (!base) {
    return null
  }
  let candidate = base
  for (let n = 2; ; n++) {
    const clash = await people(db).findOne({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {})
    })
    if (!clash) {
      return candidate
    }
    candidate = `${base}-${n}`
  }
}

function pickProfileFields(payload) {
  const fields = {}
  for (const key of PROFILE_FIELDS) {
    if (key in payload) {
      fields[key] = payload[key] ?? (key === 'canHelpWith' ? [] : null)
    }
  }
  return fields
}

export async function createPerson(db, payload) {
  const now = new Date()
  const email = normaliseEmail(payload.email)

  if (email) {
    const existing = await people(db).findOne({ email })
    if (existing) {
      throw new PeopleError('duplicate_email', email)
    }
  }

  const doc = {
    ...emptyProfileFields(),
    ...pickProfileFields(payload),
    email,
    slug: null,
    approved: payload.approved ?? true,
    isAdmin: false,
    isLineManager: false,
    managerId: null,
    helping: [],
    gdad: {},
    gdadScoresNotifiedAt: null,
    gdadScoresNotifiedById: null,
    activatedAt: null,
    createdAt: now,
    updatedAt: now
  }
  doc.slug = await ensureUniqueSlug(db, doc.name)

  const { insertedId } = await people(db).insertOne(doc)
  return toApiPerson({ _id: insertedId, ...doc })
}

export async function getPerson(db, idOrSlug) {
  const id = toId(idOrSlug)
  const doc = id
    ? await people(db).findOne({ _id: id })
    : await people(db).findOne({ slug: idOrSlug })
  return toApiPerson(doc)
}

export async function getPersonByEmail(db, email) {
  const doc = await people(db).findOne({ email: normaliseEmail(email) })
  return toApiPerson(doc)
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function listPeople(db, { filter, sort } = {}) {
  const query = {}
  if (filter) {
    const pattern = new RegExp(escapeRegex(filter.trim()), 'i')
    query.$or = [
      { name: pattern },
      { role: pattern },
      { canHelpWith: pattern },
      { canHelpWithText: pattern },
      { developmentGoalsText: pattern }
    ]
  }

  const direction = sort === 'z-a' ? -1 : 1
  const docs = await people(db)
    .find(query)
    .collation({ locale: 'en', strength: 2 })
    .sort({ name: direction, _id: 1 })
    .toArray()
  return docs.map(toApiPerson)
}

export async function updatePerson(db, idOrSlug, payload) {
  const current = await requirePerson(db, idOrSlug)
  const $set = { ...pickProfileFields(payload), updatedAt: new Date() }

  if ('email' in payload) {
    const email = normaliseEmail(payload.email)
    if (email) {
      const clash = await people(db).findOne({
        email,
        _id: { $ne: new ObjectId(current.id) }
      })
      if (clash) {
        throw new PeopleError('duplicate_email', email)
      }
    }
    $set.email = email
  }
  if ('approved' in payload) {
    $set.approved = Boolean(payload.approved)
  }

  // A person gets a slug the first time they gain a name; it then stays
  // stable so profile URLs never break on rename.
  if (!current.slug && $set.name) {
    $set.slug = await ensureUniqueSlug(db, $set.name, new ObjectId(current.id))
  }

  await people(db).updateOne({ _id: new ObjectId(current.id) }, { $set })
  return getPerson(db, current.id)
}

async function requirePerson(db, idOrSlug) {
  const person = await getPerson(db, idOrSlug)
  if (!person) {
    throw new PeopleError('not_found', idOrSlug)
  }
  return person
}

export async function deletePerson(db, idOrSlug, mode = 'full') {
  const person = await requirePerson(db, idOrSlug)
  const id = new ObjectId(person.id)

  if (mode === 'access') {
    await people(db).updateOne(
      { _id: id },
      { $set: { approved: false, updatedAt: new Date() } }
    )
    return getPerson(db, person.id)
  }

  if (mode === 'profile') {
    await people(db).updateOne(
      { _id: id },
      { $set: { ...emptyProfileFields(), slug: null, updatedAt: new Date() } }
    )
    return getPerson(db, person.id)
  }

  await people(db).deleteOne({ _id: id })
  await people(db).updateMany({ helping: id }, { $pull: { helping: id } })
  await people(db).updateMany({ managerId: id }, { $set: { managerId: null } })
  return null
}

export async function activatePerson(db, idOrSlug) {
  const person = await requirePerson(db, idOrSlug)
  await people(db).updateOne(
    { _id: new ObjectId(person.id), activatedAt: null },
    { $set: { activatedAt: new Date() } }
  )
  return getPerson(db, person.id)
}

export async function setAdmin(db, idOrSlug, isAdmin) {
  const person = await requirePerson(db, idOrSlug)
  await people(db).updateOne(
    { _id: new ObjectId(person.id) },
    { $set: { isAdmin: Boolean(isAdmin), updatedAt: new Date() } }
  )
  return getPerson(db, person.id)
}

export async function setHelping(
  db,
  idOrSlug,
  { availabilityStatus, helpeeIds }
) {
  const person = await requirePerson(db, idOrSlug)
  const selfId = new ObjectId(person.id)

  let helping = []
  if (availabilityStatus !== 'Free to help') {
    const ids = [...new Set((helpeeIds ?? []).map(String))]
      .map(toId)
      .filter(Boolean)
      .filter((id) => !id.equals(selfId))
      .slice(0, MAX_HELPING_ROWS)
    const found = await people(db)
      .find({ _id: { $in: ids } }, { projection: { _id: 1 } })
      .toArray()
    helping = found.map((doc) => doc._id)
  }

  await people(db).updateOne(
    { _id: selfId },
    { $set: { availabilityStatus, helping, updatedAt: new Date() } }
  )
  return getPerson(db, person.id)
}

export async function listHelpingPairs(db) {
  const docs = await people(db)
    .find({ 'helping.0': { $exists: true } })
    .sort({ name: 1 })
    .toArray()
  const byId = new Map(docs.map((doc) => [doc._id.toString(), doc]))

  // Helpees may not be helpers themselves; fetch any missing docs
  const missing = new Set()
  for (const doc of docs) {
    for (const helpeeId of doc.helping) {
      if (!byId.has(helpeeId.toString())) {
        missing.add(helpeeId.toString())
      }
    }
  }
  if (missing.size > 0) {
    const extra = await people(db)
      .find({ _id: { $in: [...missing].map((id) => new ObjectId(id)) } })
      .toArray()
    for (const doc of extra) {
      byId.set(doc._id.toString(), doc)
    }
  }

  const pairs = []
  for (const doc of docs) {
    for (const helpeeId of doc.helping) {
      const helpee = byId.get(helpeeId.toString())
      if (helpee) {
        pairs.push({
          helper: toApiPerson(doc),
          helpee: toApiPerson(helpee),
          since: doc.updatedAt ?? null
        })
      }
    }
  }
  return pairs
}

export async function replaceLineManagers(db, personIds) {
  const ids = (personIds ?? []).map(toId).filter(Boolean)
  await people(db).updateMany(
    { _id: { $nin: ids }, isLineManager: true },
    { $set: { isLineManager: false } }
  )
  if (ids.length > 0) {
    await people(db).updateMany(
      { _id: { $in: ids } },
      { $set: { isLineManager: true } }
    )
  }
  // Allocations must always point at a current line manager
  await people(db).updateMany(
    { managerId: { $nin: ids, $ne: null } },
    { $set: { managerId: null } }
  )
  return listPeople(db)
}

export async function setManager(db, idOrSlug, managerIdValue) {
  const person = await requirePerson(db, idOrSlug)
  let managerId = null
  if (managerIdValue) {
    const manager = await people(db).findOne({
      _id: toId(managerIdValue),
      isLineManager: true
    })
    if (!manager || manager._id.toString() === person.id) {
      throw new PeopleError('invalid_manager', managerIdValue)
    }
    managerId = manager._id
  }
  await people(db).updateOne(
    { _id: new ObjectId(person.id) },
    { $set: { managerId, updatedAt: new Date() } }
  )
  return getPerson(db, person.id)
}

function checkSkillKey(skillKey) {
  if (!GDAD_SKILL_KEYS.includes(skillKey)) {
    throw new PeopleError('invalid_skill', skillKey)
  }
}

function cleanEvidence(skillKey, text) {
  const value = String(text ?? '').trim()
  if (value.length > MAX_EVIDENCE_LENGTH) {
    throw new PeopleError('evidence_too_long', skillKey)
  }
  return value
}

export async function upsertGdadEvidence(
  db,
  idOrSlug,
  evidenceBySkill,
  updatedById
) {
  const person = await requirePerson(db, idOrSlug)
  const updaterId = toId(updatedById)
  const $set = {}
  const now = new Date()
  for (const [skillKey, text] of Object.entries(evidenceBySkill)) {
    checkSkillKey(skillKey)
    const value = cleanEvidence(skillKey, text)
    $set[`gdad.${skillKey}.evidenceText`] = value || null
    $set[`gdad.${skillKey}.evidenceUpdatedAt`] = value ? now : null
    $set[`gdad.${skillKey}.evidenceUpdatedById`] = value ? updaterId : null
  }
  await people(db).updateOne({ _id: new ObjectId(person.id) }, { $set })
  return getPerson(db, person.id)
}

/**
 * New evidence is what a designer works on towards the next annual review.
 * It sits alongside the current (scored) evidence until it is scored, and can
 * only be started once there is current evidence. Empty text discards it.
 */
export async function upsertGdadNewEvidence(
  db,
  idOrSlug,
  evidenceBySkill,
  updatedById
) {
  const person = await requirePerson(db, idOrSlug)
  const updaterId = toId(updatedById)
  const filter = { _id: new ObjectId(person.id) }
  const $set = {}
  const now = new Date()
  for (const [skillKey, text] of Object.entries(evidenceBySkill)) {
    checkSkillKey(skillKey)
    const value = cleanEvidence(skillKey, text)
    if (value) {
      if (!person.gdad[skillKey]?.evidenceText) {
        throw new PeopleError('no_current_evidence', skillKey)
      }
      // Guard against the current evidence being cleared in the meantime
      filter[`gdad.${skillKey}.evidenceText`] = { $type: 'string', $ne: '' }
    }
    $set[`gdad.${skillKey}.newEvidenceText`] = value || null
    $set[`gdad.${skillKey}.newEvidenceUpdatedAt`] = value ? now : null
    $set[`gdad.${skillKey}.newEvidenceUpdatedById`] = value ? updaterId : null
  }
  const { matchedCount } = await people(db).updateOne(filter, { $set })
  if (matchedCount === 0) {
    throw new PeopleError('no_current_evidence', Object.keys(evidenceBySkill))
  }
  return getPerson(db, person.id)
}

export const MAX_GDAD_PREVIOUS = 20
const MAX_SCORE_ATTEMPTS = 3

/**
 * Scoring a skill that has new evidence first promotes it: the current
 * evidence and its score move to the front of `previous`, and the new
 * evidence becomes current. Clearing a score (null) never promotes.
 *
 * The update is a single updateOne per person. It only applies if the
 * evidence it read is unchanged, and retries a few times if not. A retry
 * refuses (concurrent_update) if a scored skill's new evidence differs from
 * the first read, so the score never lands on evidence the reviewer didn't see.
 */
export async function upsertGdadScores(
  db,
  idOrSlug,
  scoresBySkill,
  scoredById
) {
  const person = await requirePerson(db, idOrSlug)
  const _id = new ObjectId(person.id)
  const scorerId = toId(scoredById)
  for (const skillKey of Object.keys(scoresBySkill)) {
    checkSkillKey(skillKey)
  }

  const scoredSkills = Object.entries(scoresBySkill)
    .filter(([, score]) => score !== null)
    .map(([skillKey]) => skillKey)
  const newEvidenceOf = (doc, skillKey) =>
    doc.gdad?.[skillKey]?.newEvidenceText ?? null
  let firstRead = null

  for (let attempt = 0; attempt < MAX_SCORE_ATTEMPTS; attempt++) {
    const doc = await people(db).findOne({ _id })
    if (!doc) {
      throw new PeopleError('not_found', idOrSlug)
    }
    if (!firstRead) {
      firstRead = doc
    } else if (
      scoredSkills.some(
        (skillKey) =>
          newEvidenceOf(doc, skillKey) !== newEvidenceOf(firstRead, skillKey)
      )
    ) {
      throw new PeopleError('concurrent_update', person.id)
    }
    const filter = { _id }
    const $set = {}
    const $push = {}
    const now = new Date()

    for (const [skillKey, score] of Object.entries(scoresBySkill)) {
      const path = `gdad.${skillKey}`
      if (score === null) {
        $set[`${path}.officialScore`] = null
        $set[`${path}.scoredById`] = null
        $set[`${path}.scoredAt`] = null
        continue
      }

      const entry = doc.gdad?.[skillKey] ?? {}
      if (entry.newEvidenceText) {
        filter[`${path}.newEvidenceText`] = entry.newEvidenceText
        filter[`${path}.evidenceText`] = entry.evidenceText ?? null
        if (entry.evidenceText || entry.officialScore != null) {
          $push[`${path}.previous`] = {
            $each: [
              {
                evidenceText: entry.evidenceText ?? null,
                evidenceUpdatedAt: entry.evidenceUpdatedAt ?? null,
                evidenceUpdatedById: entry.evidenceUpdatedById ?? null,
                officialScore: entry.officialScore ?? null,
                scoredAt: entry.scoredAt ?? null,
                scoredById: entry.scoredById ?? null,
                archivedAt: now
              }
            ],
            $position: 0,
            $slice: MAX_GDAD_PREVIOUS
          }
        }
        $set[`${path}.evidenceText`] = entry.newEvidenceText
        $set[`${path}.evidenceUpdatedAt`] = entry.newEvidenceUpdatedAt ?? now
        $set[`${path}.evidenceUpdatedById`] =
          entry.newEvidenceUpdatedById ?? null
        $set[`${path}.newEvidenceText`] = null
        $set[`${path}.newEvidenceUpdatedAt`] = null
        $set[`${path}.newEvidenceUpdatedById`] = null
      } else {
        // Matches null or missing: new evidence must not appear unscored
        filter[`${path}.newEvidenceText`] = null
      }
      $set[`${path}.officialScore`] = score
      $set[`${path}.scoredById`] = scorerId
      $set[`${path}.scoredAt`] = now
    }

    const update = Object.keys($push).length > 0 ? { $set, $push } : { $set }
    const { matchedCount } = await people(db).updateOne(filter, update)
    if (matchedCount === 1) {
      return getPerson(db, person.id)
    }
  }
  throw new PeopleError('concurrent_update', person.id)
}

/**
 * Records that the Head of Design has emailed this person to say their GDaD
 * scores were updated. Person-level: one timestamp covers all skills.
 */
export async function markGdadScoresNotified(db, idOrSlug, notifiedById) {
  const person = await requirePerson(db, idOrSlug)
  await people(db).updateOne(
    { _id: new ObjectId(person.id) },
    {
      $set: {
        gdadScoresNotifiedAt: new Date(),
        gdadScoresNotifiedById: toId(notifiedById)
      }
    }
  )
  return getPerson(db, person.id)
}

export async function seedApprovedEmails(db, emails) {
  for (const raw of emails ?? []) {
    const email = normaliseEmail(raw)
    if (!email) {
      continue
    }
    const existing = await people(db).findOne({ email })
    if (!existing) {
      await createPerson(db, { email })
    }
  }
}
