import * as path from 'path'
import * as fs from 'fs'
import * as https from 'https'
import { OutputDirection, OutputFormat, OutputSchema } from './schema'
import { debug, info, trace } from './logger'
import {
  GeneratorBase } from './generator.base'
import { array } from './utils'
import { Component, Context, EMPTY_LAYER, Layers } from './types'

export class Generator extends GeneratorBase {
  generate (): Promise<string[]> {
    return Promise.all(this.config.outputs.reduce((promises, output) => {
      let puml = this.generatePlantUML(output)

      puml = `${puml}

' View and edit on https://arkit.herokuapp.com`

      if (output.path && output.path.length) {
        for (const outputPath of array(output.path)!) {
          promises.push(this.convert(outputPath, puml))
        }
      } else {
        promises.push(this.convert('svg', puml))
      }

      return promises
    }, [] as Promise<string>[]))
  }

  private generatePlantUML (output: OutputSchema): string {
    info('Generating components...')
    const components = this.sortComponentsByName(
      this.resolveConflictingComponentNames(this.generateComponents(output))
    )
    trace(Array.from(components.values()))

    info('Generating layers...')
    const layers = this.generateLayers(output, components)
    trace(Array.from(layers.keys()))

    const puml = ['@startuml']

    puml.push(this.generatePlantUMLSkin(output, layers))

    for (const [layer, components] of layers.entries()) {
      puml.push(this.generatePlantUMLLayer(layer, components))
    }

    puml.push(this.generatePlantUMLRelationships(layers))
    puml.push('')
    puml.push('@enduml')

    return puml.join('\n')
  }

  private generatePlantUMLLayer (
    layer: string | Symbol,
    components: Set<Component>
  ): string {
    if (!components.size) return ''

    const puml = ['']
    const isLayer = layer !== EMPTY_LAYER

    if (isLayer) puml.push(`package "${layer}" {`)

    for (const component of components) {
      const componentPuml = [
        this.generatePlantUMLComponent(component, Context.LAYER)
      ]

      if (isLayer) componentPuml.unshift('  ')
      puml.push(componentPuml.join(''))
    }

    if (isLayer) puml.push('}')

    return puml.join('\n')
  }

  private generatePlantUMLComponent (
    component: Component,
    context: Context
  ): string {
    const puml: string[] = []
    const isDirectory = component.filename.endsWith('**')
    const hasLayer = component.layer !== EMPTY_LAYER
    const safeName = component.name.replace(/[^\w]/g, '_')

    if (isDirectory) {
      puml.push(`[${component.name}]`)
    } else if (hasLayer) {
      puml.push(`(${component.name})`)
    } else {
      if (context === Context.RELATIONSHIP) {
        puml.push(safeName)
      } else {
        puml.push('rectangle "')
        if (!component.isImported) puml.push('<b>')
        puml.push(component.name)
        if (!component.isImported) puml.push('</b>')
        puml.push(`" as ${safeName}`)
      }
    }

    return puml.join('')
  }

  private generatePlantUMLRelationships (layers: Layers): string {
    const puml = ['']
    const components = this.getAllComponents(layers, true)

    for (const component of components) {
      for (const importedFilename of component.imports) {
        const importedComponent = components.find(
          importedComponent => importedComponent.filename === importedFilename
        )

        if (importedComponent) {
          const connectionLength = this.getConnectionLength(component, importedComponent)
          const connectionSign = this.getConnectionSign(component, importedComponent)
          const connection = connectionSign.repeat(connectionLength) + '>'
          const relationshipUML = [
            this.generatePlantUMLComponent(component, Context.RELATIONSHIP),
            connection,
            this.generatePlantUMLComponent(importedComponent, Context.RELATIONSHIP)
          ]

          puml.push(relationshipUML.join(' '))
        }
      }
    }

    return puml.join('\n')
  }

  private getConnectionLength (component: Component, importedComponent: Component): number {
    const numberOfLevels = path
      .dirname(path.relative(component.filename, importedComponent.filename))
      .split(path.sep).length

    return Math.max(
      component.isImported ? 2 : 1,
      Math.min(4, numberOfLevels)
    )
  }

  private getConnectionSign (component: Component, importedComponent: Component): string {
    if (!component.isImported) return '='
    if (component.layer === importedComponent.layer && component.layer !== EMPTY_LAYER) return '.'
    return '-'
  }

  /**
   * https://github.com/plantuml/plantuml/blob/master/src/net/sourceforge/plantuml/SkinParam.java
   */
  private generatePlantUMLSkin (output: OutputSchema, layers: Layers): string {
    const puml = ['']

    puml.push('scale max 1920 width')

    const direction =
      output.direction || this.getAllComponents(layers).length > 20
        ? OutputDirection.HORIZONTAL
        : OutputDirection.VERTICAL

    if (direction === OutputDirection.HORIZONTAL) {
      puml.push('left to right direction')
    } else {
      puml.push('top to bottom direction')
    }

    puml.push(this.generatePlantUMLSkinParams())

    return puml.join('\n')
  }

  private generatePlantUMLSkinParams (): string {
    return `
skinparam monochrome true
skinparam shadowing false
skinparam nodesep 20
skinparam ranksep 20
skinparam defaultFontName Tahoma
skinparam defaultFontSize 12
skinparam roundCorner 4
skinparam dpi 150
skinparam arrowThickness 0.7
skinparam packageTitleAlignment left

' oval
skinparam usecase {
  borderThickness 0.4
  fontSize 12
}

' rectangle
skinparam rectangle {
  borderThickness 0.8
}

' component
skinparam component {
  borderThickness 1.2
}
`
  }

  private convert (pathOrType: string, puml: string): Promise<string> {
    const fullExportPath = path.resolve(this.config.directory, pathOrType)
    const ext = path.extname(fullExportPath)
    const shouldConvertAndSave = Object.values(OutputFormat).includes(ext.replace('.', ''))
    const shouldConvertAndOutput = Object.values(OutputFormat).includes(pathOrType)

    if (fs.existsSync(fullExportPath)) {
      debug('Removing', fullExportPath)
      fs.unlinkSync(fullExportPath)
    }

    if (shouldConvertAndSave || shouldConvertAndOutput) {
      debug('Converting', ext ? fullExportPath : pathOrType)
      return this.convertToImage(puml, ext || pathOrType).then(image => {
        if (shouldConvertAndSave) {
          debug('Saving', fullExportPath, image.length)
          fs.writeFileSync(fullExportPath, image)
        }

        return image.toString()
      }).catch(err => {
        throw err
      })
    } else {
      if (ext === '.puml') {
        debug('Saving', fullExportPath)
        fs.writeFileSync(fullExportPath, puml)
      }

      return Promise.resolve(puml)
    }
  }

  requestChain: Promise<any> = Promise.resolve()

  convertToImage (puml: string, format: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const path = format.match(/\w{3}/)

      if (!path) {
        return reject(new Error(`Cannot identify image format from ${format}`))
      }

      this.requestChain = this.requestChain.then(() => {
        return this.request(`/${path[0]}`, puml)
          .then(result => resolve(result))
          .catch(err => debug(err))
      })
    })
  }

  private request (path, payload): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = https
        .request(
          {
            path,
            hostname: 'arkit.herokuapp.com',
            port: 443,
            method: 'post',
            headers: {
              'Content-Type': 'text/plain',
              'Content-Length': payload.length
            }
          },
          res => {
            const data: Buffer[] = []

            res.on('data', chunk => data.push(chunk))
            res.on('end', () => {
              resolve(Buffer.concat(data))
            })
          }
        )
        .on('error', err => {
          reject(err)
        })

      req.write(payload)
      req.end()
    })
  }
}
