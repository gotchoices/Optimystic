module.exports = {
	overrides: [
		{
			files: ['src/**/*.ts', 'test/**/*.ts'],
			rules: {
				// Project uses tabs; allow them and disable space-based indent rules
				'no-tabs': 'off',
				indent: 'off',
				'@typescript-eslint/indent': 'off',
				// Relax strict stylistic rules in tests/helpers
				'@typescript-eslint/space-before-function-paren': 'off',
				'@typescript-eslint/explicit-function-return-type': 'off',
				'@typescript-eslint/strict-boolean-expressions': 'off',
				'@typescript-eslint/no-non-null-assertion': 'off',
				'@typescript-eslint/no-unnecessary-type-assertion': 'off',
				'@typescript-eslint/return-await': 'off',
				'@typescript-eslint/no-confusing-void-expression': 'off',
				'@typescript-eslint/method-signature-style': 'off',
				'promise/param-names': 'off',
				'import/order': 'off',
				'no-multiple-empty-lines': 'off'
			}
		}
	]
}

