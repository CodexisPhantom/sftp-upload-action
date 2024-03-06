import { debug, getBooleanInput, getInput, setFailed, warning } from "@actions/core"
import * as Client from "ssh2-sftp-client"
import Upload from "./types/Upload"
import pLimit from "p-limit"
import axios from "axios"
import * as fs from "fs"

/** 
 * Converts a list of uploads as as string into an array of objects
 * Example Format: 
 * from/ => to/
 * from/file => to/
 * */
function parse_uploads(uploads_str: string): Upload[] {
	const data: string[] = uploads_str.split("\n").filter(d => d != "")
	const uploads: Upload[] = []

	if (data.length === 0)
		throw new Error("No uploads were defined, please ensure you enter destinations to upload your files!")

	data.forEach(upload => {
		const [from, to] = upload.trim().split("=>")
		if (!from || !to)
			return
		uploads.push({
			from: from.trim(),
			to: to.trim()
		})
	})
	return uploads
}

// returns a list of glob patterns from a string
function parse_delete_folders(ignored_str: string): string[] {
	return ignored_str.trim().split("\n").map(Function.prototype.call, String.prototype.trim).filter(e => e != "")
}

// recursively delete a remote folder
async function delete_folder(sftp: Client, dir: string) {
	debug(`Deleting existing files for ${dir}...`)
	try {
		await sftp.rmdir(dir, true)
		debug(`${dir} has been deleted.`)
	} catch (e: any) {
		warning(`Unable to delete existing files for ${dir} before upload. ${e}`)
	}
}

// read a file and convert it to a string. Returns an empty string if the path is empty.
function file_to_string(path: string) {
	if (path === "") {
		return ""
	}
	return fs.readFileSync(path, { encoding: "utf8" })
}

async function main(sftp: Client) {
	try {
		const port: number = +getInput("port")
		const server: string = getInput("server")
		const username: string = getInput("username")
		const password: string = getInput("password")
		const isDryRun: boolean = getBooleanInput("dry-run")
		const uploads: Upload[] = parse_uploads(getInput("uploads"))
		const delete_folders: string[] = parse_delete_folders(getInput("delete_folders"))
		const pterodactyl_api_key: string = getInput("pterodactyl_api_key")

		debug(`Connecting to ${server} as ${username} on port ${port}`)

		await sftp.connect({
			host: server,
			username: username,
			password: password,
			port: port,
		})

		// allow only 1 sftp operation to occur at once
		const limit = pLimit(1)
		const promises: Promise<string | void>[] = []

		if (!isDryRun) {
			debug("Deleting folders...")

			try {
				await axios({
					method: "post",
					url: "https://my.eralive.fr/api/client/servers/26be620d/files/delete",
					headers: {
						"Accept": "application/json",
						"Content-Type": "application/json",
						"Authorization": "Bearer " + pterodactyl_api_key,
					},
					data: {
						"root": "/",
						"files": delete_folders,
					}
				})
			} catch (error: any) {
				setFailed(error.message)
			}

			await Promise.allSettled(promises)
			promises.splice(0, promises.length)
		}

		debug("Preparing upload...")

		for (const upload of uploads) {
			debug(`Processing ${upload.from} to ${upload.to}`)

			promises.push(limit(() => sftp.uploadDir(upload.from, upload.to, {
				filter: file => {
					if (isDryRun) {
						console.log(`${file} would have been uploaded`)
						return false
					} else {
						debug(`Uploading ${file}`)
						return true
					}
				}
			})))
		}

		await Promise.allSettled(promises)
		debug("Upload process complete.")

		await sftp.end()
		debug("Session ended.")

		try {
			await axios({
				method: "post",
				url: "https://pterodactyl.file.properties/api/client/servers/1a7ce997/power",
				headers: {
					"Accept": "application/json",
					"Content-Type": "application/json",
					"Authorization": "Bearer " + pterodactyl_api_key,
				},
				data: {
					"signal": "kill",
				}
			})
		} catch (error: any) {
			setFailed(error.message)
		}

		try {
			await axios({
				method: "post",
				url: "https://pterodactyl.file.properties/api/client/servers/1a7ce997/power",
				headers: {
					"Accept": "application/json",
					"Content-Type": "application/json",
					"Authorization": "Bearer " + pterodactyl_api_key,
				},
				data: {
					"signal": "start",
				}
			})
		} catch (error: any) {
			setFailed(error.message)
		}
	} catch (error: any) {
		setFailed(error.message)
	}
}

export { main, parse_uploads, delete_folder, file_to_string }