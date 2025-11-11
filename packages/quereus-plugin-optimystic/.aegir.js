export default {
	build: {
		bundlesizeMax: '100KB',
	},
	test: {
		before: async () => {
			// Build the project before running tests
			const { execSync } = await import('child_process');
			execSync('npm run build', { stdio: 'inherit' });
		},
		files: ['test/**/*.spec.ts'],
	},
};

