// Synthetic session for the README preview; never import personal histories.
const timestamp = '2026-09-01T10:00:00.000Z';
export const preview_session = [
	{
		type: 'session',
		version: 3,
		id: 'preview-search-fix',
		cwd: '/example/project',
		timestamp,
	},
	{
		type: 'session_info',
		id: 'title',
		parentId: null,
		timestamp,
		name: 'Fixing slow search',
	},
	{
		type: 'message',
		id: 'question',
		parentId: 'title',
		timestamp,
		message: { role: 'user', content: 'What fixed slow search?' },
	},
	{
		type: 'message',
		id: 'answer',
		parentId: 'question',
		timestamp,
		message: {
			role: 'assistant',
			content:
				'We replaced the full resource scan with an indexed lookup. Search kept the same results and became much faster.',
		},
	},
];
