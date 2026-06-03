import { readFile } from 'node:fs/promises'

let commandsMetaData: any[] | null = null

export async function getMetaData() {
  if (commandsMetaData) {
    return commandsMetaData
  }

  const commandsIndex = await readFile(new URL('./commands.json', import.meta.url), 'utf-8')
  commandsMetaData = JSON.parse(commandsIndex).commands

  return commandsMetaData
}

export async function getCommand(metaData: { commandName: string }) {
  const commands = await getMetaData()
  const command = commands!.find(({ commandName }) => metaData.commandName === commandName)
  if (!command) {
    return null
  }

  const { default: commandConstructor } = await import(
    new URL(command.filePath, import.meta.url).href
  )
  return commandConstructor
}
