'use strict'

const extend = require('extend')
const _ = require('lodash')
const path = require('path')
const Inert = require('@hapi/inert')
const Vision = require('@hapi/vision')
const Joi = require('@hapi/joi')
const HapiSwagger = require('hapi-swagger')
const Mrhorse = require('mrhorse')
const logging = require('loggin')
const logUtil = require('./utilities/log-util')
const chalk = require('chalk')
const restHelperFactory = require('./utilities/rest-helper-factory')
const handlerHelper = require('./utilities/handler-helper')
const joiHelper = require('./utilities/joi-mongoose-helper')
const testHelper = require('./utilities/test-helper')
const modelGenerator = require('./utilities/model-generator')
const apiGenerator = require('./utilities/api-generator')
const defaultConfig = require('./config')
const globals = require('./globals')

const internals = {
  modelsGenerated: false,
  globalSchemas: {},
  globalModels: {},
  globalConnections: {},
  pre: []
}

const exported = {
  plugin: {
    name: 'rest-hapi',
    version: '1.0.0',
    register
  },
  config: defaultConfig,
  generateModels: generateModels,
  list: handlerHelper.list,
  find: handlerHelper.find,
  create: handlerHelper.create,
  update: handlerHelper.update,
  deleteOne: handlerHelper.deleteOne,
  deleteMany: handlerHelper.deleteMany,
  addOne: handlerHelper.addOne,
  removeOne: handlerHelper.removeOne,
  addMany: handlerHelper.addMany,
  removeMany: handlerHelper.removeMany,
  getAll: handlerHelper.getAll,
  logger: {},
  getLogger: getLogger,
  logUtil: logUtil,
  joi: {},
  joiHelper: joiHelper,
  testHelper: testHelper,
  server: {},
  schema: {},
  models: {},
  model: getModel
}

module.exports = exported

async function register(server, options) {
  module.exports.server = server

  // Register Joi as the default validator if one is not already registered.
  if (!server.realm.validator) {
    server.validator(Joi)
    module.exports.joi = Joi
  } else {
    module.exports.joi = server.realm.validator
  }

  const config = defaultConfig

  // Overwrite the default config with config set by the user
  extend(true, config, options.config)
  module.exports.config = config

  const Log = getLogger('api')

  module.exports.logger = Log

  const dbConnect = (defaultDbConfig = {}, request) => {
    const dbConfig = options.config.mongo
    extend(true, dbConfig, { name: 'default' }, defaultDbConfig)
    
    return mongooseInit(options.mongoose, Log, dbConfig, request)
  }
  // Add the logger object to the request object for access later
  server.ext('onRequest', (request, h) => {
    request.logger = Log
    request.connections = {}
    request.models = {}
    request.connect = (config) => dbConnect(config, request)
    request.model = (name, connectionName) => getModel(name, connectionName, request)

    return h.continue
  })

  if (Array.isArray(options.pre)) {
    internals.pre = options.pre
  }

  // const mongoose = mongooseInit(options.mongoose, Log, config)

  // Register mongoose connect method
  server.method('dbConnect', dbConnect)

  logUtil.logActionStart(Log, 'Initializing Server')

  let schema

  if (internals.modelsGenerated) {
    // Models generated previously
    schema = internals.globalSchemas
  } else {
    try {
      schema = await modelGenerator(options.mongoose, Log, config)
    } catch (err) {
      if (err.message.includes('no such file')) {
        Log.error(
          'The policies directory provided does not exist. ' +
            "Try setting the 'policyPath' property of the config file."
        )
      } else {
        throw err
      }
    }
  }

  module.exports.schema = schema
  internals.globalSchemas = schema

  if (!config.disableSwagger) {
    await registerHapiSwagger(server, Log, config)
  }

  await registerMrHorse(server, Log, config)

  await generateRoutes(server, options.mongoose, schema, Log, config)
}

/**
 * Allows the user to pre-generate the models before the routes in case the models are needed
 * in other plugins (ex: auth plugin might require user model)
 * @param mongoose
 * @returns {*}
 */
function generateModels(mongoose) {
  internals.modelsGenerated = true

  const config = defaultConfig

  extend(true, config, module.exports.config)

  const Log = getLogger('models')

  module.exports.logger = Log

  return modelGenerator(mongoose, Log, config).then(function(schema) {
    internals.globalSchemas = schema
    module.exports.schema = schema
    return schema
  })
}

/**
 * Get a new Log object with a root label.
 * @param label: The root label for the Log.
 * @returns {*}
 */
function getLogger(label) {
  const config = defaultConfig

  extend(true, config, module.exports.config)

  const rootLogger = logging.getLogger(chalk.gray(label))

  rootLogger.logLevel = config.loglevel

  return rootLogger
}

function getConnection(name = 'default', request) {
  let connection =
    request.connections[exported.config.mongo.defaultConnection]

  if (name !== exported.config.mongo.defaultConnection) {
    connection = request.connections[name]
  }

  if (!connection || !connection.connection) {
    if (name === exported.config.mongo.defaultConnection) {
      throw new Error(`No database connections found.`)
    }
    throw new Error(`Connection '${name}' does not exists.`)
  }

  return connection
}

function getModel(
  name,
  connectionName = exported.config.mongo.defaultConnection,
  request
) {
  const model = spawnModel(name, connectionName, request)
  if (connectionName === exported.config.mongo.defaultConnection) {
    Object.assign(model, { with: conn => getModel(name, conn, request) })
  }

  return model
}

function spawnModel(name, connectionName, request) {
  const connection = getConnection(connectionName, request)

  if (!connection.models[name]) {
    connection.models[name] = connection.connection.model(
      name,
      internals.globalSchemas[name].Schema,
      name
    )
  }

  return connection.models[name]
}

/**
 * Connect mongoose and add to globals.
 * @param mongoose
 * @param logger
 * @param config
 * @returns {*}
 */
async function mongooseInit(mongoose, logger, config, request) {
  const Log = logger.bind('mongoose-init')

  mongoose.Promise = Promise

  logUtil.logActionStart(
    Log,
    'Connecting to Database',
    _.omit(config, ['pass'])
  )

  const options = Object.assign(
    {
      useNewUrlParser: true,
      useUnifiedTopology: true
    },
    config.options
  )

  if (
    request.connections[config.name] &&
    request.connections[config.name].connection
  ) {
    Log.warn(
      `Connection ${chalk.yellow(config.name)} already exists. Skipping...`
    )
    return request.connections[config.name]
  }

  const connection = await mongoose.createConnection(config.URI, options)
  request.connections[config.name] = {
    name: config.name,
    models: {},
    connection
  }

  globals.mongoose = mongoose

  Log.log('mongoose connected')

  return connection
}

/**
 * Register and configure the mrhorse plugin.
 * @param server
 * @param logger
 * @param config
 * @returns {Promise<void>}
 */
async function registerMrHorse(server, logger, config) {
  const Log = logger.bind('register-MrHorse')

  let policyPath = ''

  if (config.enablePolicies) {
    if (config.absolutePolicyPath === true) {
      policyPath = config.policyPath
    } else {
      policyPath = __dirname.replace(
        path.join('node_modules', 'rest-hapi'),
        config.policyPath
      )
    }
  } else {
    policyPath = path.join(__dirname, '/policies')
  }
  await server.register([
    {
      plugin: Mrhorse,
      options: {
        policyDirectory: policyPath
      }
    }
  ])

  if (config.enablePolicies) {
    await server.plugins.mrhorse.loadPolicies(server, {
      policyDirectory: path.join(__dirname, '/policies')
    })
  }

  Log.info('MrHorse plugin registered')
}

/**
 * Register and configure the hapi-swagger plugin.
 * @param server
 * @param logger
 * @param config
 * @returns {Promise<void>}
 */
async function registerHapiSwagger(server, logger, config) {
  const Log = logger.bind('register-hapi-swagger')

  let swaggerOptions = {
    documentationPath: '/',
    host: config.swaggerHost,
    expanded: config.docExpansion,
    swaggerUI: config.enableSwaggerUI,
    documentationPage: config.enableSwaggerUI,
    schemes: config.enableSwaggerHttps ? ['https'] : ['http']
  }

  // if swagger config is defined, use that
  if (config.swaggerOptions) {
    swaggerOptions = { ...swaggerOptions, ...config.swaggerOptions }
  }

  // override some options for safety
  if (!swaggerOptions.info) {
    swaggerOptions.info = {}
  }

  swaggerOptions.info.title = config.appTitle
  swaggerOptions.info.version = config.version
  swaggerOptions.reuseDefinitions = false

  await server.register([
    Inert,
    Vision,
    { plugin: HapiSwagger, options: swaggerOptions }
  ])

  Log.info('hapi-swagger plugin registered')
}

function generateRoutes(server, mongoose, models, logger, config) {
  const Log = logger.bind()

  const restHelper = restHelperFactory(logger, mongoose, server)

  for (const modelKey in models) {
    // Generate endpoints for all of the models
    const model = models[modelKey]
    restHelper.generateRoutes(server, model, { models: models })
  }

  // Generate custom endpoints
  return apiGenerator(server, mongoose, Log, config)
}
