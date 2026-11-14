import { Collection, ObjectId } from 'mongodb'

describe('people API', () => {
  let server

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 0 })
  })

  beforeEach(async () => {
    await server.db.collection('people').deleteMany({})
  })

  async function createPerson(payload) {
    const { result, statusCode } = await server.inject({
      method: 'POST',
      url: '/people',
      payload
    })
    expect(statusCode).toBe(201)
    return result
  }

  describe('create and fetch', () => {
    test('creates a person with profile and unique slug', async () => {
      const person = await createPerson({
        email: 'Jane.Smith@defra.gov.uk',
        name: 'Jane Smith',
        role: 'Service Designer'
      })

      expect(person.email).toBe('jane.smith@defra.gov.uk')
      expect(person.slug).toBe('jane-smith')
      expect(person.approved).toBe(true)
      expect(person.availabilityStatus).toBe('Some capacity')
      expect(person.activatedAt).toBeNull()
    })

    test('suffixes the slug on duplicate names', async () => {
      await createPerson({ name: 'Jane Smith' })
      const second = await createPerson({ name: 'Jane Smith' })
      expect(second.slug).toBe('jane-smith-2')
    })

    test('creates an allow-list only person with just an email', async () => {
      const person = await createPerson({ email: 'new@defra.gov.uk' })
      expect(person.slug).toBeNull()
      expect(person.name).toBeNull()
      expect(person.approved).toBe(true)
    })

    test('refuses a duplicate email regardless of case', async () => {
      await createPerson({ email: 'dup@defra.gov.uk' })
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/people',
        payload: { email: 'DUP@defra.gov.uk' }
      })
      expect(statusCode).toBe(409)
    })

    test('fetches by id, slug and email', async () => {
      const person = await createPerson({
        email: 'fetch@defra.gov.uk',
        name: 'Fetch Me'
      })

      const byId = await server.inject({ url: `/people/${person.id}` })
      expect(byId.result.id).toBe(person.id)

      const bySlug = await server.inject({ url: '/people/fetch-me' })
      expect(bySlug.result.id).toBe(person.id)

      const byEmail = await server.inject({
        url: '/people/by-email/fetch@defra.gov.uk'
      })
      expect(byEmail.result.id).toBe(person.id)

      const missing = await server.inject({ url: '/people/nope' })
      expect(missing.statusCode).toBe(404)
    })

    test('rejects an invalid role', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/people',
        payload: { name: 'Bad Role', role: 'Wizard' }
      })
      expect(statusCode).toBe(400)
    })
  })

  describe('list, filter and sort', () => {
    beforeEach(async () => {
      await createPerson({
        name: 'Alice Adams',
        role: 'Service Designer',
        canHelpWith: ['Design critiques'],
        canHelpWithText: 'Accessibility audits'
      })
      await createPerson({
        name: 'Zoe Zhang',
        role: 'Interaction Designer',
        developmentGoalsText: 'Wants help with prototyping'
      })
    })

    test('lists people a-z by default', async () => {
      const { result } = await server.inject({ url: '/people' })
      expect(result.map((p) => p.name)).toEqual(['Alice Adams', 'Zoe Zhang'])
    })

    test('sorts z-a', async () => {
      const { result } = await server.inject({ url: '/people?sort=z-a' })
      expect(result.map((p) => p.name)).toEqual(['Zoe Zhang', 'Alice Adams'])
    })

    test('filters across help fields, names and roles', async () => {
      const byTag = await server.inject({ url: '/people?filter=critiques' })
      expect(byTag.result.map((p) => p.name)).toEqual(['Alice Adams'])

      const byGoal = await server.inject({ url: '/people?filter=prototyping' })
      expect(byGoal.result.map((p) => p.name)).toEqual(['Zoe Zhang'])

      const byRole = await server.inject({ url: '/people?filter=interaction' })
      expect(byRole.result.map((p) => p.name)).toEqual(['Zoe Zhang'])
    })
  })

  describe('update', () => {
    test('updates profile fields and keeps the slug stable on rename', async () => {
      const person = await createPerson({ name: 'Old Name' })
      const { result } = await server.inject({
        method: 'PATCH',
        url: `/people/${person.id}`,
        payload: { name: 'New Name', bio: 'Hello' }
      })
      expect(result.name).toBe('New Name')
      expect(result.bio).toBe('Hello')
      expect(result.slug).toBe('old-name')
    })

    test('assigns a slug when a profile-less person gains a name', async () => {
      const person = await createPerson({ email: 'noname@defra.gov.uk' })
      const { result } = await server.inject({
        method: 'PATCH',
        url: `/people/${person.id}`,
        payload: { name: 'Now Named' }
      })
      expect(result.slug).toBe('now-named')
    })
  })

  describe('delete modes', () => {
    test('full delete removes the person and cleans references', async () => {
      const manager = await createPerson({ name: 'The Manager' })
      const helper = await createPerson({ name: 'The Helper' })
      const target = await createPerson({ name: 'Delete Me' })

      await server.inject({
        method: 'PUT',
        url: '/line-managers',
        payload: { personIds: [target.id] }
      })
      await server.inject({
        method: 'PUT',
        url: `/people/${manager.id}/manager`,
        payload: { managerId: target.id }
      })
      await server.inject({
        method: 'PUT',
        url: `/people/${helper.id}/helping`,
        payload: { availabilityStatus: 'Busy', helpeeIds: [target.id] }
      })

      const del = await server.inject({
        method: 'DELETE',
        url: `/people/${target.id}`
      })
      expect(del.statusCode).toBe(200)

      const managerAfter = await server.inject({ url: `/people/${manager.id}` })
      expect(managerAfter.result.managerId).toBeNull()

      const helperAfter = await server.inject({ url: `/people/${helper.id}` })
      expect(helperAfter.result.helping).toEqual([])
    })

    test('profile delete keeps email and approval', async () => {
      const person = await createPerson({
        email: 'keep@defra.gov.uk',
        name: 'Keep Access'
      })
      const { result } = await server.inject({
        method: 'DELETE',
        url: `/people/${person.id}?mode=profile`
      })
      expect(result.name).toBeNull()
      expect(result.slug).toBeNull()
      expect(result.email).toBe('keep@defra.gov.uk')
      expect(result.approved).toBe(true)
    })

    test('access delete keeps the profile but revokes sign-in', async () => {
      const person = await createPerson({
        email: 'revoke@defra.gov.uk',
        name: 'Keep Profile'
      })
      const { result } = await server.inject({
        method: 'DELETE',
        url: `/people/${person.id}?mode=access`
      })
      expect(result.name).toBe('Keep Profile')
      expect(result.approved).toBe(false)
    })
  })

  describe('activation and admin', () => {
    test('activation is recorded once', async () => {
      const person = await createPerson({ email: 'act@defra.gov.uk' })
      const first = await server.inject({
        method: 'POST',
        url: `/people/${person.id}/activate`
      })
      expect(first.result.activatedAt).not.toBeNull()

      const second = await server.inject({
        method: 'POST',
        url: `/people/${person.id}/activate`
      })
      expect(second.result.activatedAt).toEqual(first.result.activatedAt)
    })

    test('grants and revokes admin', async () => {
      const person = await createPerson({ email: 'adm@defra.gov.uk' })
      const granted = await server.inject({
        method: 'POST',
        url: `/people/${person.id}/admin`,
        payload: { isAdmin: true }
      })
      expect(granted.result.isAdmin).toBe(true)

      const revoked = await server.inject({
        method: 'POST',
        url: `/people/${person.id}/admin`,
        payload: { isAdmin: false }
      })
      expect(revoked.result.isAdmin).toBe(false)
    })
  })

  describe('helping', () => {
    test('replaces the helpee list, excluding self and unknown ids', async () => {
      const helper = await createPerson({ name: 'Helper One' })
      const helpee = await createPerson({ name: 'Helpee One' })

      const { result } = await server.inject({
        method: 'PUT',
        url: `/people/${helper.id}/helping`,
        payload: {
          availabilityStatus: 'Busy',
          helpeeIds: [helpee.id, helper.id, '64b000000000000000000000']
        }
      })
      expect(result.availabilityStatus).toBe('Busy')
      expect(result.helping).toEqual([helpee.id])
    })

    test('Free to help forces an empty helpee list', async () => {
      const helper = await createPerson({ name: 'Helper Two' })
      const helpee = await createPerson({ name: 'Helpee Two' })

      const { result } = await server.inject({
        method: 'PUT',
        url: `/people/${helper.id}/helping`,
        payload: {
          availabilityStatus: 'Free to help',
          helpeeIds: [helpee.id]
        }
      })
      expect(result.helping).toEqual([])
    })

    test('lists helper-helpee pairs', async () => {
      const helper = await createPerson({ name: 'Pair Helper' })
      const helpee = await createPerson({ name: 'Pair Helpee' })
      await server.inject({
        method: 'PUT',
        url: `/people/${helper.id}/helping`,
        payload: { availabilityStatus: 'Busy', helpeeIds: [helpee.id] }
      })

      const { result } = await server.inject({ url: '/helping-pairs' })
      expect(result).toHaveLength(1)
      expect(result[0].helper.name).toBe('Pair Helper')
      expect(result[0].helpee.name).toBe('Pair Helpee')
    })
  })

  describe('line managers and allocations', () => {
    test('replacing line managers prunes stale allocations', async () => {
      const managerA = await createPerson({ name: 'Manager A' })
      const managerB = await createPerson({ name: 'Manager B' })
      const staff = await createPerson({ name: 'Staff One' })

      await server.inject({
        method: 'PUT',
        url: '/line-managers',
        payload: { personIds: [managerA.id, managerB.id] }
      })
      await server.inject({
        method: 'PUT',
        url: `/people/${staff.id}/manager`,
        payload: { managerId: managerA.id }
      })

      // Remove manager A from the line-manager set
      await server.inject({
        method: 'PUT',
        url: '/line-managers',
        payload: { personIds: [managerB.id] }
      })

      const staffAfter = await server.inject({ url: `/people/${staff.id}` })
      expect(staffAfter.result.managerId).toBeNull()

      const managerAAfter = await server.inject({
        url: `/people/${managerA.id}`
      })
      expect(managerAAfter.result.isLineManager).toBe(false)
    })

    test('refuses allocation to a non-line-manager or self', async () => {
      const notManager = await createPerson({ name: 'Not Manager' })
      const staff = await createPerson({ name: 'Staff Two' })

      const invalid = await server.inject({
        method: 'PUT',
        url: `/people/${staff.id}/manager`,
        payload: { managerId: notManager.id }
      })
      expect(invalid.statusCode).toBe(400)

      await server.inject({
        method: 'PUT',
        url: '/line-managers',
        payload: { personIds: [staff.id] }
      })
      const self = await server.inject({
        method: 'PUT',
        url: `/people/${staff.id}/manager`,
        payload: { managerId: staff.id }
      })
      expect(self.statusCode).toBe(400)
    })
  })

  describe('GDaD evidence and scores', () => {
    test('saves and clears evidence per skill', async () => {
      const person = await createPerson({ name: 'Designer One' })

      const saved = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/evidence`,
        payload: { evidence: { iterative_design: 'Situation: did a thing' } }
      })
      expect(saved.result.gdad.iterative_design.evidenceText).toBe(
        'Situation: did a thing'
      )
      expect(saved.result.gdad.iterative_design.evidenceUpdatedAt).toBeTruthy()

      const cleared = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/evidence`,
        payload: { evidence: { iterative_design: '' } }
      })
      expect(cleared.result.gdad.iterative_design.evidenceText).toBeNull()
    })

    test('rejects an unknown skill key', async () => {
      const person = await createPerson({ name: 'Designer Two' })
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/evidence`,
        payload: { evidence: { juggling: 'irrelevant' } }
      })
      expect(statusCode).toBe(400)
    })

    test('saves and clears scores with the scorer recorded', async () => {
      const person = await createPerson({ name: 'Designer Three' })
      const scorer = await createPerson({ name: 'The Scorer' })

      const scored = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/scores`,
        payload: {
          scores: { leading_design: 3, iterative_design: 1 },
          scoredById: scorer.id
        }
      })
      expect(scored.result.gdad.leading_design.officialScore).toBe(3)
      expect(scored.result.gdad.leading_design.scoredById).toBe(scorer.id)

      const cleared = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/scores`,
        payload: {
          scores: { leading_design: null },
          scoredById: scorer.id
        }
      })
      expect(cleared.result.gdad.leading_design.officialScore).toBeNull()
      expect(cleared.result.gdad.leading_design.scoredById).toBeNull()
    })

    test('rejects an out-of-range score', async () => {
      const person = await createPerson({ name: 'Designer Four' })
      const scorer = await createPerson({ name: 'Scorer Two' })
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/scores`,
        payload: { scores: { leading_design: 5 }, scoredById: scorer.id }
      })
      expect(statusCode).toBe(400)
    })
  })

  describe('GDaD new evidence and previous evidence', () => {
    const NEW_FIELDS_EMPTY = {
      newEvidenceText: null,
      newEvidenceUpdatedAt: null,
      newEvidenceUpdatedById: null
    }

    function put(url, payload) {
      return server.inject({ method: 'PUT', url, payload })
    }

    async function saveEvidence(person, evidence, updatedById) {
      const response = await put(`/people/${person.id}/gdad/evidence`, {
        evidence,
        ...(updatedById ? { updatedById } : {})
      })
      expect(response.statusCode).toBe(200)
      return response.result
    }

    async function saveNewEvidence(person, evidence, updatedById) {
      return put(`/people/${person.id}/gdad/new-evidence`, {
        evidence,
        ...(updatedById ? { updatedById } : {})
      })
    }

    async function score(person, scores, scoredById) {
      const response = await put(`/people/${person.id}/gdad/scores`, {
        scores,
        scoredById
      })
      expect(response.statusCode).toBe(200)
      return response.result
    }

    test('old records come back with the new fields defaulted', async () => {
      const scorerId = new ObjectId()
      await server.db.collection('people').insertOne({
        name: 'Legacy Person',
        slug: 'legacy-person',
        gdad: {
          iterative_design: {
            evidenceText: 'Old evidence',
            evidenceUpdatedAt: new Date('2025-01-02T03:04:05Z'),
            officialScore: 2,
            scoredAt: new Date('2025-09-10T00:00:00Z'),
            scoredById: scorerId
          }
        }
      })

      const { result } = await server.inject({ url: '/people/legacy-person' })
      expect(result.gdad.iterative_design).toEqual({
        evidenceText: 'Old evidence',
        evidenceUpdatedAt: '2025-01-02T03:04:05.000Z',
        evidenceUpdatedById: null,
        officialScore: 2,
        scoredAt: '2025-09-10T00:00:00.000Z',
        scoredById: scorerId.toString(),
        ...NEW_FIELDS_EMPTY,
        previous: []
      })
    })

    test('evidence records who updated it, and still works without', async () => {
      const person = await createPerson({ name: 'Evidence Updater' })
      const editor = await createPerson({ name: 'The Editor' })

      const withId = await saveEvidence(
        person,
        { iterative_design: 'Some evidence' },
        editor.id
      )
      expect(withId.gdad.iterative_design.evidenceUpdatedById).toBe(editor.id)
      expect(typeof withId.gdad.iterative_design.evidenceUpdatedAt).toBe(
        'string'
      )

      const withoutId = await saveEvidence(person, {
        iterative_design: 'Edited evidence'
      })
      expect(withoutId.gdad.iterative_design.evidenceText).toBe(
        'Edited evidence'
      )
      expect(withoutId.gdad.iterative_design.evidenceUpdatedById).toBeNull()
      expect(withoutId.gdad.iterative_design).toMatchObject(NEW_FIELDS_EMPTY)
      expect(withoutId.gdad.iterative_design.previous).toEqual([])

      const badId = await put(`/people/${person.id}/gdad/evidence`, {
        evidence: { iterative_design: 'x' },
        updatedById: 'not-an-id'
      })
      expect(badId.statusCode).toBe(400)
    })

    test('sets, trims and clears new evidence', async () => {
      const person = await createPerson({ name: 'New Evidence Person' })
      const editor = await createPerson({ name: 'New Editor' })
      await saveEvidence(person, { leading_design: 'Current evidence' })

      const saved = await saveNewEvidence(
        person,
        { leading_design: '  Working on it  ' },
        editor.id
      )
      expect(saved.statusCode).toBe(200)
      const entry = saved.result.gdad.leading_design
      expect(entry.newEvidenceText).toBe('Working on it')
      expect(typeof entry.newEvidenceUpdatedAt).toBe('string')
      expect(entry.newEvidenceUpdatedById).toBe(editor.id)
      expect(entry.evidenceText).toBe('Current evidence')

      const cleared = await saveNewEvidence(person, { leading_design: '' })
      expect(cleared.statusCode).toBe(200)
      expect(cleared.result.gdad.leading_design).toMatchObject({
        ...NEW_FIELDS_EMPTY,
        evidenceText: 'Current evidence'
      })
    })

    test('refuses new evidence when there is no current evidence', async () => {
      const person = await createPerson({ name: 'No Current Evidence' })
      const response = await saveNewEvidence(person, {
        designing_together: 'Too early'
      })
      expect(response.statusCode).toBe(409)
      expect(response.result.code).toBe('no_current_evidence')

      const { result } = await server.inject({ url: `/people/${person.id}` })
      expect(result.gdad.designing_together).toBeUndefined()
    })

    test('rejects new evidence that is too long, an unknown skill or person', async () => {
      const person = await createPerson({ name: 'Validation Person' })
      await saveEvidence(person, { leading_design: 'Current' })

      const tooLong = await saveNewEvidence(person, {
        leading_design: 'x'.repeat(12001)
      })
      expect(tooLong.statusCode).toBe(400)

      const badSkill = await saveNewEvidence(person, { juggling: 'x' })
      expect(badSkill.statusCode).toBe(400)

      const empty = await put(`/people/${person.id}/gdad/new-evidence`, {
        evidence: {}
      })
      expect(empty.statusCode).toBe(400)

      const unknown = await put(
        '/people/0123456789abcdef01234567/gdad/new-evidence',
        { evidence: { leading_design: 'x' } }
      )
      expect(unknown.statusCode).toBe(404)
    })

    test('scoring new evidence promotes it and archives the old evidence', async () => {
      const person = await createPerson({ name: 'Promoted Person' })
      const scorer = await createPerson({ name: 'Head Scorer' })
      const editor = await createPerson({ name: 'Promo Editor' })

      await saveEvidence(person, { iterative_design: 'Year one' }, editor.id)
      const firstScore = await score(person, { iterative_design: 1 }, scorer.id)
      const before = firstScore.gdad.iterative_design

      const withNew = await saveNewEvidence(
        person,
        { iterative_design: 'Year two' },
        editor.id
      )
      const newUpdatedAt =
        withNew.result.gdad.iterative_design.newEvidenceUpdatedAt

      const promoted = await score(person, { iterative_design: 3 }, scorer.id)
      const entry = promoted.gdad.iterative_design
      expect(entry.evidenceText).toBe('Year two')
      expect(entry.evidenceUpdatedAt).toBe(newUpdatedAt)
      expect(entry.evidenceUpdatedById).toBe(editor.id)
      expect(entry.officialScore).toBe(3)
      expect(entry.scoredById).toBe(scorer.id)
      expect(entry).toMatchObject(NEW_FIELDS_EMPTY)

      expect(entry.previous).toHaveLength(1)
      expect(entry.previous[0]).toEqual({
        evidenceText: 'Year one',
        evidenceUpdatedAt: before.evidenceUpdatedAt,
        evidenceUpdatedById: editor.id,
        officialScore: 1,
        scoredAt: before.scoredAt,
        scoredById: scorer.id,
        archivedAt: expect.any(String)
      })
      expect(Date.parse(entry.previous[0].archivedAt)).toBeGreaterThanOrEqual(
        Date.parse(before.scoredAt)
      )

      // Stored as real dates and ids, not strings
      const raw = await server.db
        .collection('people')
        .findOne({ _id: new ObjectId(person.id) })
      const archived = raw.gdad.iterative_design.previous[0]
      expect(archived.archivedAt).toBeInstanceOf(Date)
      expect(archived.scoredAt).toBeInstanceOf(Date)
      expect(archived.scoredById).toBeInstanceOf(ObjectId)
    })

    test('a null score never promotes', async () => {
      const person = await createPerson({ name: 'Null Score Person' })
      const scorer = await createPerson({ name: 'Null Scorer' })
      await saveEvidence(person, { leading_design: 'Current' })
      await score(person, { leading_design: 2 }, scorer.id)
      await saveNewEvidence(person, { leading_design: 'Next' })

      const cleared = await score(person, { leading_design: null }, scorer.id)
      const entry = cleared.gdad.leading_design
      expect(entry.officialScore).toBeNull()
      expect(entry.evidenceText).toBe('Current')
      expect(entry.newEvidenceText).toBe('Next')
      expect(entry.previous).toEqual([])
    })

    test('skills without new evidence are scored exactly as before', async () => {
      const person = await createPerson({ name: 'Mixed Skills Person' })
      const scorer = await createPerson({ name: 'Mixed Scorer' })
      await saveEvidence(person, {
        leading_design: 'Leading current',
        iterative_design: 'Iterative current'
      })
      await score(person, { leading_design: 1, iterative_design: 1 }, scorer.id)
      await saveNewEvidence(person, { leading_design: 'Leading next' })

      const result = await score(
        person,
        { leading_design: 2, iterative_design: 2 },
        scorer.id
      )
      expect(result.gdad.leading_design.evidenceText).toBe('Leading next')
      expect(result.gdad.leading_design.previous).toHaveLength(1)

      const iterative = result.gdad.iterative_design
      expect(iterative.evidenceText).toBe('Iterative current')
      expect(iterative.officialScore).toBe(2)
      expect(iterative.previous).toEqual([])
      expect(iterative).toMatchObject(NEW_FIELDS_EMPTY)
    })

    test('previous evidence is newest first and capped at 20', async () => {
      const person = await createPerson({ name: 'Many Years Person' })
      const scorer = await createPerson({ name: 'Many Scorer' })
      await saveEvidence(person, { evidence_based_design: 'Year 0' })
      await score(person, { evidence_based_design: 1 }, scorer.id)

      for (let year = 1; year <= 22; year++) {
        const response = await saveNewEvidence(person, {
          evidence_based_design: `Year ${year}`
        })
        expect(response.statusCode).toBe(200)
        await score(
          person,
          { evidence_based_design: (year % 3) + 1 },
          scorer.id
        )
      }

      const { result } = await server.inject({ url: `/people/${person.id}` })
      const entry = result.gdad.evidence_based_design
      expect(entry.evidenceText).toBe('Year 22')
      expect(entry.previous).toHaveLength(20)
      expect(entry.previous[0].evidenceText).toBe('Year 21')
      expect(entry.previous[19].evidenceText).toBe('Year 2')
      const archivedTimes = entry.previous.map((p) => Date.parse(p.archivedAt))
      expect([...archivedTimes].sort((a, b) => b - a)).toEqual(archivedTimes)
    })

    test('old previous entries default evidenceUpdatedById to null', async () => {
      await server.db.collection('people').insertOne({
        name: 'Legacy History',
        slug: 'legacy-history',
        gdad: {
          leading_design: {
            evidenceText: 'Now',
            previous: [{ evidenceText: 'Then', officialScore: 1 }]
          }
        }
      })
      const { result } = await server.inject({ url: '/people/legacy-history' })
      expect(result.gdad.leading_design.previous).toEqual([
        {
          evidenceText: 'Then',
          evidenceUpdatedAt: null,
          evidenceUpdatedById: null,
          officialScore: 1,
          scoredAt: null,
          scoredById: null,
          archivedAt: null
        }
      ])
    })

    test('promotes a skill whose current evidence was cleared', async () => {
      const person = await createPerson({ name: 'Cleared Current' })
      const scorer = await createPerson({ name: 'Cleared Scorer' })
      await saveEvidence(person, { designing_together: 'First' })
      await score(person, { designing_together: 2 }, scorer.id)
      await saveNewEvidence(person, { designing_together: 'Second' })
      await saveEvidence(person, { designing_together: '' })

      const result = await score(person, { designing_together: 3 }, scorer.id)
      const entry = result.gdad.designing_together
      expect(entry.evidenceText).toBe('Second')
      expect(entry.officialScore).toBe(3)
      expect(entry).toMatchObject(NEW_FIELDS_EMPTY)
      expect(entry.previous).toHaveLength(1)
      expect(entry.previous[0]).toMatchObject({
        evidenceText: null,
        evidenceUpdatedAt: null,
        evidenceUpdatedById: null,
        officialScore: 2,
        scoredById: scorer.id
      })
    })

    test('a skill with a score but no evidence', async () => {
      const person = await createPerson({ name: 'Score Only' })
      const scorer = await createPerson({ name: 'Score Only Scorer' })

      const first = await score(person, { leading_design: 2 }, scorer.id)
      expect(first.gdad.leading_design).toMatchObject({
        evidenceText: null,
        evidenceUpdatedAt: null,
        officialScore: 2,
        ...NEW_FIELDS_EMPTY,
        previous: []
      })

      const refused = await saveNewEvidence(person, { leading_design: 'Next' })
      expect(refused.statusCode).toBe(409)
      expect(refused.result.code).toBe('no_current_evidence')

      const rescored = await score(person, { leading_design: 3 }, scorer.id)
      expect(rescored.gdad.leading_design.officialScore).toBe(3)
      expect(rescored.gdad.leading_design.previous).toEqual([])
    })

    describe('when the record changes mid-save', () => {
      const realUpdateOne = Collection.prototype.updateOne

      afterEach(() => {
        vi.restoreAllMocks()
      })

      // Runs `write` just before the next updateOne, i.e. after the scores
      // route has read the record
      function interceptNextUpdate(write) {
        vi.spyOn(Collection.prototype, 'updateOne').mockImplementationOnce(
          async function (...args) {
            await write()
            return realUpdateOne.apply(this, args)
          }
        )
      }

      test('retries and promotes when only the current evidence changed', async () => {
        const person = await createPerson({ name: 'Retry Person' })
        const scorer = await createPerson({ name: 'Retry Scorer' })
        await saveEvidence(person, { leading_design: 'Current' })
        await score(person, { leading_design: 1 }, scorer.id)
        await saveNewEvidence(person, { leading_design: 'Next' })

        interceptNextUpdate(() =>
          realUpdateOne.call(
            server.db.collection('people'),
            { _id: new ObjectId(person.id) },
            { $set: { 'gdad.leading_design.evidenceText': 'Current edited' } }
          )
        )
        const result = await score(person, { leading_design: 2 }, scorer.id)
        const entry = result.gdad.leading_design
        expect(entry.evidenceText).toBe('Next')
        expect(entry.officialScore).toBe(2)
        expect(entry.previous).toHaveLength(1)
        expect(entry.previous[0].evidenceText).toBe('Current edited')
      })

      test('refuses with concurrent_update when new evidence appears', async () => {
        const person = await createPerson({ name: 'Race Person' })
        const scorer = await createPerson({ name: 'Race Scorer' })
        await saveEvidence(person, { leading_design: 'Current' })

        interceptNextUpdate(() =>
          realUpdateOne.call(
            server.db.collection('people'),
            { _id: new ObjectId(person.id) },
            { $set: { 'gdad.leading_design.newEvidenceText': 'Unseen' } }
          )
        )
        const response = await put(`/people/${person.id}/gdad/scores`, {
          scores: { leading_design: 2 },
          scoredById: scorer.id
        })
        expect(response.statusCode).toBe(409)
        expect(response.result.code).toBe('concurrent_update')

        const { result } = await server.inject({ url: `/people/${person.id}` })
        const entry = result.gdad.leading_design
        expect(entry.evidenceText).toBe('Current')
        expect(entry.newEvidenceText).toBe('Unseen')
        expect(entry.officialScore).toBeNull()
        expect(entry.previous).toEqual([])
      })
    })

    test('scores reject an unknown skill or person', async () => {
      const scorer = await createPerson({ name: 'Reject Scorer' })
      const person = await createPerson({ name: 'Reject Person' })

      const badSkill = await put(`/people/${person.id}/gdad/scores`, {
        scores: { juggling: 2 },
        scoredById: scorer.id
      })
      expect(badSkill.statusCode).toBe(400)

      const unknown = await put(
        '/people/0123456789abcdef01234567/gdad/scores',
        {
          scores: { leading_design: 2 },
          scoredById: scorer.id
        }
      )
      expect(unknown.statusCode).toBe(404)
    })
  })

  describe('GDaD scores notified', () => {
    test('new and old people report no notification yet', async () => {
      const fresh = await createPerson({ name: 'Fresh Person' })
      expect(fresh.gdadScoresNotifiedAt).toBeNull()
      expect(fresh.gdadScoresNotifiedById).toBeNull()

      // A document saved before these fields existed
      const { insertedId } = await server.db
        .collection('people')
        .insertOne({ name: 'Old Person', slug: 'old-person', gdad: {} })
      const old = await server.inject({ url: `/people/${insertedId}` })
      expect(old.statusCode).toBe(200)
      expect(old.result.gdadScoresNotifiedAt).toBeNull()
      expect(old.result.gdadScoresNotifiedById).toBeNull()
    })

    test('records when and by whom, and returns it everywhere', async () => {
      const person = await createPerson({ name: 'Designer Five' })
      const head = await createPerson({ name: 'Head Of Design' })
      const before = Date.now()

      const { statusCode, result } = await server.inject({
        method: 'PUT',
        url: `/people/${person.id}/gdad/scores-notified`,
        payload: { notifiedById: head.id }
      })
      expect(statusCode).toBe(200)
      expect(result.id).toBe(person.id)
      expect(result.gdadScoresNotifiedById).toBe(head.id)
      expect(typeof result.gdadScoresNotifiedAt).toBe('string')
      const notifiedAt = Date.parse(result.gdadScoresNotifiedAt)
      expect(new Date(notifiedAt).toISOString()).toBe(
        result.gdadScoresNotifiedAt
      )
      expect(notifiedAt).toBeGreaterThanOrEqual(before - 1000)
      expect(notifiedAt).toBeLessThanOrEqual(Date.now() + 1000)

      const fetched = await server.inject({ url: `/people/${person.id}` })
      expect(fetched.result.gdadScoresNotifiedAt).toBe(
        result.gdadScoresNotifiedAt
      )
      expect(fetched.result.gdadScoresNotifiedById).toBe(head.id)

      const list = await server.inject({ url: '/people' })
      const listed = list.result.find((p) => p.id === person.id)
      expect(listed.gdadScoresNotifiedAt).toBe(result.gdadScoresNotifiedAt)
      expect(listed.gdadScoresNotifiedById).toBe(head.id)
      const other = list.result.find((p) => p.id === head.id)
      expect(other.gdadScoresNotifiedAt).toBeNull()
      expect(other.gdadScoresNotifiedById).toBeNull()

      // Stored as real Date / ObjectId values
      const raw = await server.db
        .collection('people')
        .findOne({ slug: 'designer-five' })
      expect(raw.gdadScoresNotifiedAt).toBeInstanceOf(Date)
      expect(raw.gdadScoresNotifiedById.toString()).toBe(head.id)
    })

    test('returns 404 for an unknown person', async () => {
      const head = await createPerson({ name: 'Head Two' })
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: '/people/0123456789abcdef01234567/gdad/scores-notified',
        payload: { notifiedById: head.id }
      })
      expect(statusCode).toBe(404)
    })

    test('returns 400 for a missing or invalid notifier id', async () => {
      const person = await createPerson({ name: 'Designer Six' })
      for (const payload of [
        {},
        { notifiedById: 'not-an-id' },
        { notifiedById: null }
      ]) {
        const { statusCode } = await server.inject({
          method: 'PUT',
          url: `/people/${person.id}/gdad/scores-notified`,
          payload
        })
        expect(statusCode).toBe(400)
      }
    })
  })
})
