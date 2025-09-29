import { expect } from 'aegir/chai'
import { assembleTwoSidedCohort } from '../src/fret/cohort.js'

function fakePeer(id: string): any {
  return {
    toString() { return id },
    toMultihash() { return { bytes: new TextEncoder().encode(id.padStart(32, '0')).slice(0, 32) } }
  }
}

describe('FRET cohort alternation property', () => {
  it('alternates around anchors when wants <= peers', () => {
    const peers = Array.from({ length: 8 }, (_, i) => fakePeer(`p-${i}`))
    const key = new TextEncoder().encode('p-3'.padStart(32, '0')).slice(0, 32)
    const { anchors, cohort } = assembleTwoSidedCohort(key, peers as any, 6)
    expect(anchors[0]).to.exist
    expect(cohort.length).to.equal(6)
    // Weak property: no duplicates
    const ids = cohort.map(p => p.toString())
    expect(new Set(ids).size).to.equal(ids.length)
  })
})

