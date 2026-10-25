import type { TaskCoordinator } from './coordinator.js';
export const recoverBeforeDispatch=(coordinator:TaskCoordinator)=>coordinator.recover();
