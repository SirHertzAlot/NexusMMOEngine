/**
 * Weather field task (roadmap WX1): advance the coarse weather simulation by
 * a batch of steps, off the main thread.
 *
 * Stateless like pcgHandler: the payload carries the field arrays in (as
 * transferables) plus the scalar params, seed, steps and dt, and the result
 * returns the updated arrays. The main thread owns the arrays between calls.
 *
 * Transferable semantics: the runtime transfers every array in the payload,
 * so the main thread's references are detached for the duration of the call.
 * The handler mutates `moisture`/`temperature` in place and returns them, and
 * also returns the two climatology arrays (unchanged) so the main thread gets
 * fresh, re-attached copies to feed the next call. Callers must therefore use
 * the arrays from the RESULT, not the ones they passed in.
 */
import { runWeatherSteps, type WeatherFieldParams } from '../../render/weather/field.js';
import type { WorkerTaskHandler } from '../types.js';

export const weatherHandler: WorkerTaskHandler<'weather'> = {
  type: 'weather',
  async handle(payload) {
    const { moisture, temperature, params, seed, steps, dt } = payload;
    runWeatherSteps(moisture, temperature, params as WeatherFieldParams, seed, steps, dt);
    return {
      moisture,
      temperature,
      climatologyTemp: params.climatologyTemp,
      climatologyMoisture: params.climatologyMoisture,
    };
  },
};
