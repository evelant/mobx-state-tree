import { argsToArray, fail, setImmediateWithFallback } from "../utils"
import {
    getCurrentActionContext,
    getNextActionId,
    getParentActionContext,
    IMiddlewareEventType,
    runWithActionContext
} from "./action"

/**
 * @hidden
 */
export type CancellablePromise<T> = Promise<T> & { cancel(): void }

/**
 * @hidden
 */
export type FlowReturn<R> = R extends Promise<infer T> ? T : R

/**
 * See [asynchronous actions](concepts/async-actions.md).
 *
 * @returns The flow as a promise.
 */
export function flow<R, Args extends any[]>(
    // <<<<<<< HEAD
    //     generator: (...args: Args) => Generator<PromiseLike<any>, R, any>
    // ): (...args: Args) => Promise<FlowReturn<R>> {
    //     return createFlowSpawner(generator.name, generator) as any
    // =======
    generator: (...args: Args) => Generator<PromiseLike<any>, R, any>
): (...args: Args) => CancellablePromise<FlowReturn<R>> {
    return createFlowSpawner(generator.name, generator)
    // >>>>>>> 0e8a1726 (Add cancel method to promises returned from flow)
}

/**
 * @deprecated Not needed since TS3.6.
 * Used for TypeScript to make flows that return a promise return the actual promise result.
 *
 * @param val
 * @returns
 */
export function castFlowReturn<T>(val: T): T {
    return val as any
}

/**
 * @experimental
 * experimental api - might change on minor/patch releases
 *
 * Convert a promise-returning function to a generator-returning one.
 * This is intended to allow for usage of `yield*` in async actions to
 * retain the promise return type.
 *
 * Example:
 * ```ts
 * function getDataAsync(input: string): Promise<number> { ... }
 * const getDataGen = toGeneratorFunction(getDataAsync);
 *
 * const someModel.actions(self => ({
 *   someAction: flow(function*() {
 *     // value is typed as number
 *     const value = yield* getDataGen("input value");
 *     ...
 *   })
 * }))
 * ```
 */
export function toGeneratorFunction<R, Args extends any[]>(p: (...args: Args) => Promise<R>) {
    return function* (...args: Args) {
        return (yield p(...args)) as R
    }
}

/**
 * @experimental
 * experimental api - might change on minor/patch releases
 *
 * Convert a promise to a generator yielding that promise
 * This is intended to allow for usage of `yield*` in async actions to
 * retain the promise return type.
 *
 * Example:
 * ```ts
 * function getDataAsync(input: string): Promise<number> { ... }
 *
 * const someModel.actions(self => ({
 *   someAction: flow(function*() {
 *     // value is typed as number
 *     const value = yield* toGenerator(getDataAsync("input value"));
 *     ...
 *   })
 * }))
 * ```
 */
export function* toGenerator<R>(p: Promise<R>) {
    return (yield p) as R
}

/**
 * @internal
 * @hidden
 */
export function createFlowSpawner<R, Args extends any[]>(
    name: string,
    generator: (...args: Args) => Generator<PromiseLike<any>, R, any>
): (...args: Args) => CancellablePromise<FlowReturn<R>> {
    const spawner = function flowSpawner(...generatorArgs: Args) {
        // Implementation based on https://github.com/tj/co/blob/master/index.js
        const runId = getNextActionId()
        const parentContext = getCurrentActionContext()!
        if (!parentContext) {
            throw fail("a mst flow must always have a parent context")
        }
        const parentActionContext = getParentActionContext(parentContext)
        if (!parentActionContext) {
            throw fail("a mst flow must always have a parent action context")
        }

        const contextBase = {
            name,
            id: runId,
            tree: parentContext.tree,
            context: parentContext.context,
            parentId: parentContext.id,
            allParentIds: [...parentContext.allParentIds, parentContext.id],
            rootId: parentContext.rootId,
            parentEvent: parentContext,
            parentActionEvent: parentActionContext
        }

        const args = arguments

        let thisFlowGenerator: Generator<PromiseLike<any>, R, any>
        let resolver: (value: any) => void
        let rejector: (error: any) => void

        /**
         * When a yielded promise resolves or rejects resume the flow by first calling middlewares
         */
        function wrap(fn: any, type: IMiddlewareEventType, arg: any) {
            fn.$mst_middleware = (spawner as any).$mst_middleware // pick up any middleware attached to the flow
            runWithActionContext(
                {
                    ...contextBase,
                    type,
                    args: [arg]
                },
                fn
            )
        }

        /**
         * When a yielded promise is fulfilled call middlewares and resume the flow generator
         * with the fulfilled value
         */
        function onFulfilled(res: any) {
            let ret
            try {
                // prettier-ignore
                wrap((r: any) => { ret = thisFlowGenerator.next(r) }, "flow_resume", res)
            } catch (e) {
                // prettier-ignore
                setImmediateWithFallback(() => {
                    wrap((r: any) => { rejector(e) }, "flow_throw", e)
                })
                return
            }
            handleThisFlowGeneratorNextValue(ret)
            return
        }

        /**
         * When a yielded promise is rejected call middlewares with error and throw rejection error
         * into flow generator
         */
        function onRejected(err: any) {
            let ret
            try {
                // prettier-ignore
                wrap((r: any) => { ret = thisFlowGenerator.throw(r) }, "flow_resume_error", err) // or yieldError?
            } catch (e) {
                // prettier-ignore
                setImmediateWithFallback(() => {
                    wrap((r: any) => { rejector(e) }, "flow_throw", e)
                })
                return
            }
            handleThisFlowGeneratorNextValue(ret)
        }

        /**
         * Push the next value into the flow generator function or finish the flow.
         * Unfortunately it's currently impossible to type the "return" of `yield` in TS 4.1
         * https://github.com/microsoft/TypeScript/issues/32523
         */
        function handleThisFlowGeneratorNextValue(ret: any) {
            if (ret.done) {
                // prettier-ignore
                setImmediateWithFallback(() => {
                    wrap((r: any) => { resolver(r) }, "flow_return", ret.value)
                })
                return
            }
            // TODO: support more type of values? See https://github.com/tj/co/blob/249bbdc72da24ae44076afd716349d2089b31c4c/index.js#L100
            if (!ret.value || typeof ret.value.then !== "function") {
                // istanbul ignore next
                throw fail("Only promises can be yielded to `async`, got: " + ret)
            }
            return ret.value.then(onFulfilled, onRejected)
        }

        const promise = new Promise<FlowReturn<R>>(function (resolve, reject) {
            resolver = resolve
            rejector = reject

            const init = function asyncActionInit() {
                thisFlowGenerator = generator.apply(null, generatorArgs)
                onFulfilled(undefined) // kick off the flow
            }
            ;(init as any).$mst_middleware = (spawner as any).$mst_middleware

            runWithActionContext(
                {
                    ...contextBase,
                    type: "flow_spawn",
                    args: argsToArray(args)
                },
                init
            )
        }) as CancellablePromise<FlowReturn<R>>

        promise.cancel = function () {
            thisFlowGenerator.next(onRejected(new Error("FLOW_CANCELLED")))
        }

        return promise
    }
    return spawner
}
