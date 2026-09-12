export const NIGHT_MODE_PLANNING_QUERY_EVENT = "night-mode:planning-query:v1";

export interface NightModePlanningQuery {
	version: 1;
	planning: boolean;
}

export const answerNightModePlanningQuery = (value: unknown, planning: boolean): void => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	const query = value as Partial<NightModePlanningQuery>;
	if (query.version === 1) query.planning = planning;
};
