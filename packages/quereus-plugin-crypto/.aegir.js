export default {
	build: {
		bundlesizeMax: '100KB',
	},
	test: {
		before: async () => {
			const { execSync } = await import('child_process');
			execSync('npm run build', { stdio: 'inherit' });
		},
		files: ['test/**/*.spec.ts'],
	},
};

