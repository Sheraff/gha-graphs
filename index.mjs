

/**
 * @typedef {import('@actions/github').context} Context
 * @typedef {import('@actions/core')} Core
 * @typedef {ReturnType<import('@actions/github').getOctokit>} GitHub
 */

/**
 * @typedef {object} ValueEntry
 * @property {number} value
 * @property {string} sha
 * @property {string} date
 */


/**
 * This is a function meant to run in a GitHub Action workflow.
 * 
 * It takes in a `value` parameter each time it runs.
 * The repository has a special branch reserved for this workflow. The name of the branch is passed in as a parameter.
 * 
 * When running this function, if the branch does not exist, it is created.
 * 
 * On the branch, we store all of the `value`s that have been passed in,
 * with the associated commit SHA, ref (branch name), and timestamp.
 * 
 * @param {object} params
 * @param {GitHub} params.github from GHA, the `github` object
 * @param {Context} params.context from GHA, the `context` object
 * @param {Core} params.core from GHA, the `core` object
 * @param {string} params.branch the branch reserved for this workflow, to store data in
 * @param {string} [params.defaultBranch] the branch with which to track the value's evolution over time
 * @param {string} [params.key] the key to store the value under, useful if this workflow is used for multiple values
 * @param {number} value the value to store
 */
export async function main({ github, context, core, branch, defaultBranch, key = 'value' }, value) {
	const { owner, repo } = context.repo

	// Get the name of the current branch
	const currentBranch = context.ref.replace('refs/heads/', '')

	// Get the repo's default branch
	if (!defaultBranch) {
		const { data: { default_branch } } = await github.rest.repos.get({
			owner,
			repo,
		})
		defaultBranch = default_branch
	}


	// Check if branch exists
	/** @type {string | null} */
	let ref = null
	try {
		const { data } = await github.rest.git.getRef({
			owner,
			repo,
			ref: `heads/${branch}`,
		})
		ref = data.ref
	} catch (error) {
		if (error.status !== 404) {
			throw error
		}
	}

	// Create branch if it doesn't exist
	if (!ref) {
		const { data: { object } } = await github.rest.git.getRef({
			owner,
			repo,
			ref: 'heads/main',
		})

		const { data } = await github.rest.git.createRef({
			owner,
			repo,
			ref: `refs/heads/${branch}`,
			sha: object.sha,
		})
		ref = data.ref
	}

	const ROOT = '.github/storage/value-tracking/'
	const path = `${ROOT}${key}/${currentBranch}.json`

	// Get contents of existing file
	/** @type {ValueEntry[]} */
	let branchData = []
	/** @type {string|undefined} */
	let sha = undefined
	try {
		const { data } = await github.rest.repos.getContent({
			owner,
			repo,
			path,
			ref: branch,
			mediaType: {
				format: 'text'
			}
		})
		if (Array.isArray(data)) {
			throw new Error(`Expected file, got directory`)
		} else if (data.type === 'file') {
			branchData = JSON.parse(Buffer.from(data.content, 'base64').toString())
			sha = data.sha
		} else {
			throw new Error(`Expected file, got ${data.type}`)
		}
	} catch (error) {
		if (error.status !== 404) {
			throw error
		}
	}

	// Get timestamp associated with current sha
	const { data: { committer } } = await github.rest.git.getCommit({
		owner,
		repo,
		commit_sha: context.sha,
	})
	const date = committer.date

	// Add the new value to the array
	const entry = { value, sha: context.sha, date }
	branchData.push(entry)

	// Create a new file / Update existing file
	const message = `Add ${key} to ${path}`
	const content = Buffer.from(JSON.stringify(branchData, null, '\t')).toString('base64')

	await github.rest.repos.createOrUpdateFileContents({
		owner,
		repo,
		path,
		message,
		content,
		branch,
		sha
	})

	const isDefaultBranch = context.ref === `refs/heads/${defaultBranch}`

	// If current branch is the default branch, update the evolution file
	if (isDefaultBranch) {
		const svg = generateEvolutionSvg(branchData)
		const evolutionPath = `.github/storage/graphs/${key}/${defaultBranch}-evolution.svg`
		const evolutionMessage = `Update ${key} evolution graph`
		const evolutionContent = Buffer.from(svg).toString('base64')
		await github.rest.repos.createOrUpdateFileContents({
			owner,
			repo,
			path: evolutionPath,
			message: evolutionMessage,
			content: evolutionContent,
			branch,
			sha,
		})
		const permalink = `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/${branch}/${evolutionPath}`
		console.log(`Evolution graph permalink: ${permalink}`)
		core.notice(permalink, {
			title: 'Evolution graph',
		})
	}

	// If the current branch is not the default branch, update the comparison file
	if (!isDefaultBranch) {
		const path = `${ROOT}${key}/${defaultBranch}.json`
		/** @type {ValueEntry[]} */
		let defaultData = []
		try {
			const { data } = await github.rest.repos.getContent({
				owner,
				repo,
				path,
				ref: branch,
				mediaType: {
					format: 'text'
				},
			})
			if (Array.isArray(data)) {
				throw new Error(`Expected file, got directory`)
			} else if (data.type === 'file') {
				branchData = JSON.parse(Buffer.from(data.content, 'base64').toString())
			} else {
				throw new Error(`Expected file, got ${data.type}`)
			}
		} catch (error) {
			if (error.status !== 404) {
				throw error
			}
		}
		if (defaultData.length) {
			const svg = generateComparisonSvg(key, entry, defaultData)
			if (svg) {
				const comparisonPath = `.github/storage/graphs/${key}/${currentBranch}-comparison-percent.svg`
				const comparisonMessage = `Update ${key} comparison graph`
				const comparisonContent = Buffer.from(svg).toString('base64')
				await github.rest.repos.createOrUpdateFileContents({
					owner,
					repo,
					content: comparisonContent,
					message: comparisonMessage,
					path: comparisonPath,
					sha,
				})
				const permalink = `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/${branch}/${comparisonPath}`
				console.log(`Comparison graph permalink: ${permalink}`)
				core.notice(permalink, {
					title: 'Comparison graph',
				})
			}
		}
	}
}


/**
 * Generate an SVG to visualize the evolution of a value over time.
 * 
 * @param {ValueEntry[]} data
 */
function generateEvolutionSvg(data) {
	data = data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
	const width = 1000
	const height = 500
	const margin = 50

	const min = Math.min(...data.map(({ value }) => value))
	const max = Math.max(...data.map(({ value }) => value))

	const xScale = (width - 2 * margin) / (data.length - 1)
	const yScale = (height - 2 * margin) / (max - min)

	const points = data.map(({ value }, i) => `${margin + i * xScale},${height - margin - (value - min) * yScale}`)

	const path = `M${points.join('L')}`

	const svg = `
		<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
			<path d="${path}" fill="none" stroke="black" stroke-width="2" />
		</svg>
	`

	return svg
}

/**
 * Generate an SVG to visualize the change in value compared to the default branch.
 * 
 * The image is a simple pill-shaped tag with the `key` on the left, and the % change on the right.
 * 
 * @param {string} key
 * @param {ValueEntry} data
 * @param {ValueEntry[]} defaultData
 */
function generateComparisonSvg(key, data, defaultData) {
	const latest = defaultData.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).pop()
	if (!latest) return

	const change = ((data.value - latest.value) / latest.value) * 100
	const color = change > 0 ? 'green' : 'red'

	const svg = `
		<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50">
			<rect x="0" y="0" rx="25" ry="25" width="200" height="50" style="fill:${color};"/>
			<text x="20" y="30" font-family="Verdana" font-size="20" fill="white">${key}</text>
			<text x="120" y="30" font-family="Verdana" font-size="20" fill="white">${change.toFixed(2)}%</text>
		</svg>
	`

	return svg
}