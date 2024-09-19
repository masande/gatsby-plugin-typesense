const fs = require("fs").promises
const cheerio = require("cheerio")
const TypesenseClient = require("typesense").Client
const TYPESENSE_ATTRIBUTE_NAME = "data-typesense-field"

let utils = require("./lib/utils")

function typeCastValue(fieldDefinition, attributeValue) {
  if (fieldDefinition.type.includes("int")) {
    return parseInt(attributeValue);
  }
  if (fieldDefinition.type.includes("float")) {
    return parseFloat(attributeValue);
  }
  if (fieldDefinition.type.includes("bool")) {
    if (attributeValue.toLowerCase() === "false") {
      return false;
    }
    if (attributeValue === "0") {
      return false;
    }
    return attributeValue.trim() !== "";
  }
  return attributeValue;
}

async function indexContentInTypesense({
  fileContents,
  wwwPath,
  typesense,
  newCollectionSchema,
  reporter,
}) {
  const $ = cheerio.load(fileContents)

  let typesenseDocument = {}
  $(`[${TYPESENSE_ATTRIBUTE_NAME}]`).each((index, element) => {
    const attributeName = $(element).attr(TYPESENSE_ATTRIBUTE_NAME)
    const attributeValue = $(element).text()
    const fieldDefinition = newCollectionSchema.fields.find(
      f => f.name === attributeName
    )

    if (!fieldDefinition) {
      const errorMsg = `[Typesense] Field "${attributeName}" is not defined in the collection schema`
      reporter.panic(errorMsg)
      return Promise.error(errorMsg)
    }

    if (fieldDefinition.type.includes("[]")) {
      typesenseDocument[attributeName] = typesenseDocument[attributeName] || []
      typesenseDocument[attributeName].push(typeCastValue(fieldDefinition, attributeValue))
    } else {
      typesenseDocument[attributeName] = typeCastValue(fieldDefinition, attributeValue);
    }
  })

  if (utils.isObjectEmpty(typesenseDocument)) {
    reporter.warn(
      `[Typesense] No HTMLelements had the ${TYPESENSE_ATTRIBUTE_NAME} attribute, skipping page`
    )
    return Promise.resolve()
  }

  typesenseDocument["page_path"] = wwwPath
  typesenseDocument["page_priority_score"] =
    typesenseDocument["page_priority_score"] || 10

  try {
    reporter.verbose(
      `[Typesense] Creating document: ${JSON.stringify(
        typesenseDocument,
        null,
        2
      )}`
    )

    await typesense
      .collections(newCollectionSchema.name)
      .documents()
      .create(typesenseDocument)

    reporter.verbose("[Typesense] ✅")
    return Promise.resolve()
  } catch (error) {
    reporter.panic(`[Typesense] Could not create document: ${error}`)
  }
}

// New function to get existing synonyms
const getExistingSynonyms = async (client, collectionName) => {
  try {
    const response = await client.collections(collectionName).synonyms().retrieve();
    return Object.values(response.synonyms || {});
  } catch (error) {
    console.warn(`Failed to retrieve synonyms from ${collectionName}:`, error);
    return [];
  }
};

// New function to upsert synonyms
const upsertSynonyms = async (client, collectionName, synonyms) => {
  for (const synonym of synonyms) {
    try {
      await client.collections(collectionName).synonyms().upsert(synonym.id, {
        synonyms: synonym.synonyms
      });
    } catch (error) {
      console.warn(`Failed to upsert synonym ${synonym.id}:`, error);
    }
  }
};

exports.onPostBuild = async (
  { reporter },
  {
    server,
    collectionSchema,
    publicDir,
    rootDir,
    exclude,
    generateNewCollectionName = utils.generateNewCollectionName,
  }
) => {
  reporter.info("[Typesense] Starting onPostBuild process")
  
  // backward compatibility
  rootDir = rootDir || publicDir
  const htmlFiles = await utils.getHTMLFilesRecursively(rootDir, rootDir, exclude)

  const typesense = new TypesenseClient(server)
  const newCollectionName = generateNewCollectionName(collectionSchema)
  const newCollectionSchema = { ...collectionSchema }
  newCollectionSchema.name = newCollectionName

  reporter.info(`[Typesense] New collection name: ${newCollectionName}`)

  let oldCollectionName
  let existingSynonyms = []

  try {
    const aliasInfo = await typesense.aliases(collectionSchema.name).retrieve()
    oldCollectionName = aliasInfo["collection_name"]
    reporter.info(`[Typesense] Old collection name: ${oldCollectionName}`)

    if (oldCollectionName) {
      reporter.info(`[Typesense] Retrieving synonyms from old collection: ${oldCollectionName}`)
      existingSynonyms = await getExistingSynonyms(typesense, oldCollectionName)
      reporter.info(`[Typesense] Retrieved ${existingSynonyms.length} synonyms from old collection`)
    }
  } catch (error) {
    reporter.warn(`[Typesense] Error retrieving old collection or synonyms: ${error.message}`)
  }

  try {
    reporter.info(`[Typesense] Creating new collection: ${newCollectionName}`)
    await typesense.collections().create(newCollectionSchema)
  } catch (error) {
    reporter.panic(`[Typesense] Could not create collection ${newCollectionName}: ${error.message}`)
  }

  for (const file of htmlFiles) {
    const wwwPath = file.replace(rootDir, "").replace(/index\.html$/, "")
    reporter.verbose(`[Typesense] Indexing ${wwwPath}`)
    const fileContents = (await fs.readFile(file)).toString()
    await indexContentInTypesense({
      fileContents,
      wwwPath,
      typesense,
      newCollectionSchema,
      reporter,
    })
  }

  if (existingSynonyms.length > 0) {
    reporter.info(`[Typesense] Upserting ${existingSynonyms.length} synonyms to new collection`)
    try {
      await upsertSynonyms(typesense, newCollectionName, existingSynonyms)
      reporter.info(`[Typesense] Successfully upserted synonyms to new collection`)
    } catch (error) {
      reporter.error(`[Typesense] Error upserting synonyms: ${error.message}`)
    }
  } else {
    reporter.info(`[Typesense] No synonyms to upsert`)
  }

  try {
    reporter.info(`[Typesense] Upserting alias ${collectionSchema.name} -> ${newCollectionName}`)
    await typesense
      .aliases()
      .upsert(collectionSchema.name, { collection_name: newCollectionName })
    reporter.info(`[Typesense] Successfully upserted alias`)
  } catch (error) {
    reporter.error(`[Typesense] Could not upsert alias ${collectionSchema.name} -> ${newCollectionName}: ${error.message}`)
  }

  if (oldCollectionName) {
    try {
      reporter.info(`[Typesense] Deleting old collection ${oldCollectionName}`)
      await typesense.collections(oldCollectionName).delete()
      reporter.info(`[Typesense] Successfully deleted old collection`)
    } catch (error) {
      reporter.error(`[Typesense] Could not delete old collection ${oldCollectionName}: ${error.message}`)
    }
  }

  reporter.info(`[Typesense] Content indexed to "${collectionSchema.name}" [${newCollectionName}]`)
}

exports.onPreInit = ({ reporter }) =>
  reporter.verbose("Loaded gatsby-plugin-typesense")
