import { use, expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
use(chaiAsPromised)
import { Pending } from '../src/utility/pending.js'

describe('Pending', () => {
  it('reports a resolved Promise<void> as complete', async () => {
    let resolve!: () => void
    const pending = new Pending<void>(new Promise<void>(r => { resolve = r }))

    expect(pending.isResponse).to.equal(false)
    expect(pending.isComplete).to.equal(false)

    resolve()
    await pending.promise

    // A void batch resolves to `undefined`; isResponse must still flip to true.
    // Previously isResponse was `response !== undefined`, which stayed false forever.
    expect(pending.isResponse).to.equal(true)
    expect(pending.isError).to.equal(false)
    expect(pending.isComplete).to.equal(true)
  })

  it('reports a resolved value response as complete', async () => {
    const pending = new Pending<number>(Promise.resolve(42))
    await pending.promise
    expect(pending.isResponse).to.equal(true)
    expect(pending.isComplete).to.equal(true)
    expect(pending.response).to.equal(42)
    expect(await pending.result()).to.equal(42)
  })

  it('reports a rejected promise as error, not response', async () => {
    const err = new Error('boom')
    const pending = new Pending<number>(Promise.reject(err))
    // Let the internal .then rejection handler run.
    await pending.promise.catch(() => undefined)
    expect(pending.isResponse).to.equal(false)
    expect(pending.isError).to.equal(true)
    expect(pending.isComplete).to.equal(true)
    await expect(pending.result()).to.be.rejectedWith('boom')
  })
})
