'use strict';

const _ = require('lodash');
const Utils = require('../../utils');
const util = require('util');
const AbstractQueryGenerator = require('../abstract/query-generator');
const Op = require('../../operators');

const QueryGenerator = {
  __proto__: AbstractQueryGenerator,
  dialect: 'mysql',

  OperatorMap: Object.assign({}, AbstractQueryGenerator.OperatorMap, {
    [Op.regexp]: 'REGEXP',
    [Op.notRegexp]: 'NOT REGEXP'
  }),

  createSchema() {
    return 'SHOW TABLES';
  },

  showSchemasQuery() {
    return 'SHOW TABLES';
  },

  versionQuery() {
    return 'SELECT VERSION() as `version`';
  },

  /**
   * Check whether the statmement is json function or simple path
   *
   * @param   {String}  stmt  The statement to validate
   * @returns {Boolean}       true if the given statement is json function
   * @throws  {Error}         throw if the statement looks like json function but has invalid token
   */
  checkValidJsonStatement(stmt) {
    if (!_.isString(stmt)) {
      return false;
    }

    // https://sqlite.org/json1.html
    const jsonFunctionRegex = /^\s*(json(?:_[a-z]+){0,2})\([^)]*\)/i;
    const tokenCaptureRegex = /^\s*((?:([`"'])(?:(?!\2).|\2{2})*\2)|[\w\d\s]+|[().,;+-])/i;

    let currentIndex = 0;
    let openingBrackets = 0;
    let closingBrackets = 0;
    let hasJsonFunction = false;
    let hasInvalidToken = false;

    while (currentIndex < stmt.length) {
      const string = stmt.substr(currentIndex);
      const functionMatches = jsonFunctionRegex.exec(string);
      if (functionMatches) {
        currentIndex += functionMatches[0].indexOf('(');
        hasJsonFunction = true;
        continue;
      }

      const tokenMatches = tokenCaptureRegex.exec(string);
      if (tokenMatches) {
        const capturedToken = tokenMatches[1];
        if (capturedToken === '(') {
          openingBrackets++;
        } else if (capturedToken === ')') {
          closingBrackets++;
        } else if (capturedToken === ';') {
          hasInvalidToken = true;
          break;
        }
        currentIndex += tokenMatches[0].length;
        continue;
      }

      break;
    }

    // Check invalid json statement
    hasInvalidToken |= openingBrackets !== closingBrackets;
    if (hasJsonFunction && hasInvalidToken) {
      throw new Error('Invalid json statement: ' + stmt);
    }

    // return true if the statement has valid json function
    return hasJsonFunction;
  },

  /**
   * Generates an SQL query that extract JSON property of given path.
   *
   * @param   {String}               column  The JSON column
   * @param   {String|Array<String>} [path]  The path to extract (optional)
   * @returns {String}                       The generated sql query
   * @private
   */
  jsonPathExtractionQuery(column, path) {
    const paths = _.toPath(path);
    const pathStr = this.escape(['$']
      .concat(paths)
      .join('.')
      .replace(/\.(\d+)(?:(?=\.)|$)/g, (_, digit) => `[${digit}]`));

    const quotedColumn = this.isIdentifierQuoted(column) ? column : this.quoteIdentifier(column);
    return `json_extract(${quotedColumn}, ${pathStr})`;
  },

  //MySQL can't cast string to NULL 
  _traverseJSON(items, baseKey, prop, item, path) {
    let cast;

    if (path[path.length - 1].indexOf('::') > -1) {
      const tmp = path[path.length - 1].split('::');
      cast = tmp[1];
      path[path.length - 1] = tmp[0];
    }

    const pathKey = this.jsonPathExtractionQuery(baseKey, path);

    if (_.isPlainObject(item)) {
      Utils.getOperators(item).forEach(op => {
        const value = item[op];
        items.push(this.whereItemQuery(this._castKey(pathKey, value, cast), {[op]: value}));
      });
      _.forOwn(item, (value, itemProp) => {
        this._traverseJSON(items, baseKey, itemProp, value, path.concat([itemProp]));
      });

      return;
    } else if (item === null) {
      item = 'NULL';
    }

    items.push(this.whereItemQuery(this._castKey(pathKey, item, cast), {[Op.eq]: item}));
  },

  handleSequelizeMethod(smth, tableName, factory, options, prepend) {
    if (smth instanceof Utils.Json) {
      // Parse nested object
      if (smth.conditions) {
        const conditions = this.parseConditionObject(smth.conditions).map(condition =>
          `${this.jsonPathExtractionQuery(_.first(condition.path), _.tail(condition.path))} = '${condition.value}'`
        );

        return conditions.join(' AND ');
      } else if (smth.path) {
        let str;

        // Allow specifying conditions using the sqlite json functions
        if (this.checkValidJsonStatement(smth.path)) {
          str = smth.path;
        } else {
          // Also support json property accessors
          const paths = _.toPath(smth.path);
          const column = paths.shift();
          str = this.jsonPathExtractionQuery(column, paths);
        }

        if (smth.value) {
          str += util.format(' = %s', this.escape(smth.value));
        }

        return str;
      }
    } else if (smth instanceof Utils.Cast) {
      // As mysql datetime casting requires unquoting
      if (smth.type === 'datetime' && smth.val.val) {
        smth.val.val = `json_unquote(${smth.val.val})`;
      } else if (smth.type === 'char' && smth.val.val) {
        smth.val.val = `json_type(${smth.val.val})`;
      }
    }
    return AbstractQueryGenerator.handleSequelizeMethod.call(this, smth, tableName, factory, options, prepend);
  },

  _getJsonCast(value) {
    // if (typeof value === 'number') {
    //   return 'double precision';
    // }
    if (value instanceof Date) {
      return 'datetime';
    }
    else if (value === 'NULL') {
      return 'char';
    }
    return;
  },

  createTableQuery(tableName, attributes, options) {
    options = _.extend({
      engine: 'InnoDB',
      charset: null,
      rowFormat: null
    }, options || {});

    const query = 'CREATE TABLE IF NOT EXISTS <%= table %> (<%= attributes%>) ENGINE=<%= engine %><%= comment %><%= charset %><%= collation %><%= initialAutoIncrement %><%= rowFormat %>';
    const primaryKeys = [];
    const foreignKeys = {};
    const attrStr = [];

    for (const attr in attributes) {
      if (attributes.hasOwnProperty(attr)) {
        const dataType = attributes[attr];
        let match;

        if (_.includes(dataType, 'PRIMARY KEY')) {
          primaryKeys.push(attr);

          if (_.includes(dataType, 'REFERENCES')) {
            // MySQL doesn't support inline REFERENCES declarations: move to the end
            match = dataType.match(/^(.+) (REFERENCES.*)$/);
            attrStr.push(this.quoteIdentifier(attr) + ' ' + match[1].replace(/PRIMARY KEY/, ''));
            foreignKeys[attr] = match[2];
          } else {
            attrStr.push(this.quoteIdentifier(attr) + ' ' + dataType.replace(/PRIMARY KEY/, ''));
          }
        } else if (_.includes(dataType, 'REFERENCES')) {
          // MySQL doesn't support inline REFERENCES declarations: move to the end
          match = dataType.match(/^(.+) (REFERENCES.*)$/);
          attrStr.push(this.quoteIdentifier(attr) + ' ' + match[1]);
          foreignKeys[attr] = match[2];
        } else {
          attrStr.push(this.quoteIdentifier(attr) + ' ' + dataType);
        }
      }
    }

    const values = {
      table: this.quoteTable(tableName),
      attributes: attrStr.join(', '),
      comment: options.comment && _.isString(options.comment) ? ' COMMENT ' + this.escape(options.comment) : '',
      engine: options.engine,
      charset: options.charset ? ' DEFAULT CHARSET=' + options.charset : '',
      collation: options.collate ? ' COLLATE ' + options.collate : '',
      rowFormat: options.rowFormat ? ' ROW_FORMAT=' + options.rowFormat : '',
      initialAutoIncrement: options.initialAutoIncrement ? ' AUTO_INCREMENT=' + options.initialAutoIncrement : ''
    };
    const pkString = primaryKeys.map(pk => this.quoteIdentifier(pk)).join(', ');

    if (options.uniqueKeys) {
      _.each(options.uniqueKeys, (columns, indexName) => {
        if (!columns.singleField) { // If it's a single field its handled in column def, not as an index
          if (!_.isString(indexName)) {
            indexName = 'uniq_' + tableName + '_' + columns.fields.join('_');
          }
          values.attributes += ', UNIQUE ' + this.quoteIdentifier(indexName) + ' (' + _.map(columns.fields, this.quoteIdentifier).join(', ') + ')';
        }
      });
    }

    if (pkString.length > 0) {
      values.attributes += ', PRIMARY KEY (' + pkString + ')';
    }

    for (const fkey in foreignKeys) {
      if (foreignKeys.hasOwnProperty(fkey)) {
        values.attributes += ', FOREIGN KEY (' + this.quoteIdentifier(fkey) + ') ' + foreignKeys[fkey];
      }
    }

    return _.template(query, this._templateSettings)(values).trim() + ';';
  },

  showTablesQuery() {
    return 'SHOW TABLES;';
  },

  addColumnQuery(table, key, dataType) {
    const definition = this.attributeToSQL(dataType, {
      context: 'addColumn',
      tableName: table,
      foreignKey: key
    });

    return `ALTER TABLE ${this.quoteTable(table)} ADD ${this.quoteIdentifier(key)} ${definition};`;
  },

  removeColumnQuery(tableName, attributeName) {
    return `ALTER TABLE ${this.quoteTable(tableName)} DROP ${this.quoteIdentifier(attributeName)};`;
  },

  changeColumnQuery(tableName, attributes) {
    const attrString = [];
    const constraintString = [];

    for (const attributeName in attributes) {
      let definition = attributes[attributeName];
      if (definition.match(/REFERENCES/)) {
        const fkName = this.quoteIdentifier(tableName + '_' + attributeName + '_foreign_idx');
        const attrName = this.quoteIdentifier(attributeName);
        definition = definition.replace(/.+?(?=REFERENCES)/, '');
        constraintString.push(`${fkName} FOREIGN KEY (${attrName}) ${definition}`);
      } else {
        attrString.push('`' + attributeName + '` `' + attributeName + '` ' + definition);
      }
    }

    let finalQuery = '';
    if (attrString.length) {
      finalQuery += 'CHANGE ' + attrString.join(', ');
      finalQuery += constraintString.length ? ' ' : '';
    }
    if (constraintString.length) {
      finalQuery += 'ADD CONSTRAINT ' + constraintString.join(', ');
    }

    return `ALTER TABLE ${this.quoteTable(tableName)} ${finalQuery};`;
  },

  renameColumnQuery(tableName, attrBefore, attributes) {
    const attrString = [];

    for (const attrName in attributes) {
      const definition = attributes[attrName];
      attrString.push('`' + attrBefore + '` `' + attrName + '` ' + definition);
    }

    return `ALTER TABLE ${this.quoteTable(tableName)} CHANGE ${attrString.join(', ')};`;
  },

  upsertQuery(tableName, insertValues, updateValues, where, model, options) {
    options.onDuplicate = 'UPDATE ';

    options.onDuplicate += Object.keys(updateValues).map(key => {
      key = this.quoteIdentifier(key);
      return key + '=VALUES(' + key +')';
    }).join(', ');

    return this.insertQuery(tableName, insertValues, model.rawAttributes, options);
  },

  deleteQuery(tableName, where, options, model) {
    options = options || {};

    const table = this.quoteTable(tableName);
    if (options.truncate === true) {
      // Truncate does not allow LIMIT and WHERE
      return 'TRUNCATE ' + table;
    }
    where = this.getWhereConditions(where, null, model, options);
    let limit = '';

    if (_.isUndefined(options.limit)) {
      options.limit = 1;
    }

    if (options.limit) {
      limit = ' LIMIT ' + this.escape(options.limit);
    }

    let query = 'DELETE FROM ' + table;
    if (where) query += ' WHERE ' + where;
    query += limit;

    return query;
  },

  showIndexesQuery(tableName, options) {
    return 'SHOW INDEX FROM ' + this.quoteTable(tableName) + ((options || {}).database ? ' FROM `' + options.database + '`' : '');
  },

  showConstraintsQuery(tableName, constraintName) {
    let sql = [
      'SELECT CONSTRAINT_CATALOG AS constraintCatalog,',
      'CONSTRAINT_NAME AS constraintName,',
      'CONSTRAINT_SCHEMA AS constraintSchema,',
      'CONSTRAINT_TYPE AS constraintType,',
      'TABLE_NAME AS tableName,',
      'TABLE_SCHEMA AS tableSchema',
      'from INFORMATION_SCHEMA.TABLE_CONSTRAINTS',
      `WHERE table_name='${tableName}'`
    ].join(' ');

    if (constraintName) {
      sql += ` AND constraint_name = '${constraintName}'`;
    }

    return sql + ';';
  },

  removeIndexQuery(tableName, indexNameOrAttributes) {
    let indexName = indexNameOrAttributes;

    if (typeof indexName !== 'string') {
      indexName = Utils.underscore(tableName + '_' + indexNameOrAttributes.join('_'));
    }

    return `DROP INDEX ${this.quoteIdentifier(indexName)} ON ${this.quoteTable(tableName)}`;
  },

  attributeToSQL(attribute, options) {
    if (!_.isPlainObject(attribute)) {
      attribute = {
        type: attribute
      };
    }

    let template = attribute.type.toString({ escape: this.escape.bind(this) });

    if (attribute.allowNull === false) {
      template += ' NOT NULL';
    }

    if (attribute.autoIncrement) {
      template += ' auto_increment';
    }

    // Blobs/texts cannot have a defaultValue
    if (attribute.type !== 'TEXT' && attribute.type._binary !== true && Utils.defaultValueSchemable(attribute.defaultValue)) {
      template += ' DEFAULT ' + this.escape(attribute.defaultValue);
    }

    if (attribute.unique === true) {
      template += ' UNIQUE';
    }

    if (attribute.primaryKey) {
      template += ' PRIMARY KEY';
    }

    if (attribute.first) {
      template += ' FIRST';
    }
    if (attribute.after) {
      template += ' AFTER ' + this.quoteIdentifier(attribute.after);
    }

    if (attribute.references) {

      if (options && options.context === 'addColumn' && options.foreignKey) {
        const attrName = this.quoteIdentifier(options.foreignKey);
        const fkName = this.quoteIdentifier(`${options.tableName}_${attrName}_foreign_idx`);

        template += `, ADD CONSTRAINT ${fkName} FOREIGN KEY (${attrName})`;
      }

      template += ' REFERENCES ' + this.quoteTable(attribute.references.model);

      if (attribute.references.key) {
        template += ' (' + this.quoteIdentifier(attribute.references.key) + ')';
      } else {
        template += ' (' + this.quoteIdentifier('id') + ')';
      }

      if (attribute.onDelete) {
        template += ' ON DELETE ' + attribute.onDelete.toUpperCase();
      }

      if (attribute.onUpdate) {
        template += ' ON UPDATE ' + attribute.onUpdate.toUpperCase();
      }
    }

    return template;
  },

  attributesToSQL(attributes, options) {
    const result = {};

    for (const key in attributes) {
      const attribute = attributes[key];
      result[attribute.field || key] = this.attributeToSQL(attribute, options);
    }

    return result;
  },

  quoteIdentifier(identifier) {
    if (identifier === '*') return identifier;
    return Utils.addTicks(Utils.removeTicks(identifier, '`'), '`');
  },

  /**
   * Generates an SQL query that returns all foreign keys of a table.
   *
   * @param  {String} tableName  The name of the table.
   * @param  {String} schemaName The name of the schema.
   * @return {String}            The generated sql query.
   * @private
   */
  getForeignKeysQuery(tableName, schemaName) {
    return "SELECT CONSTRAINT_NAME as constraint_name FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE where TABLE_NAME = '" + tableName + /* jshint ignore: line */
      "' AND CONSTRAINT_NAME!='PRIMARY' AND CONSTRAINT_SCHEMA='" + schemaName + "' AND REFERENCED_TABLE_NAME IS NOT NULL;"; /* jshint ignore: line */
  },

  /**
   * Generates an SQL query that returns the foreign key constraint of a given column.
   *
   * @param  {String} tableName  The name of the table.
   * @param  {String} columnName The name of the column.
   * @return {String}            The generated sql query.
   * @private
   */
  getForeignKeyQuery(table, columnName) {
    let tableName = table.tableName || table;
    if (table.schema) {
      tableName = table.schema + '.' + tableName;
    }
    return 'SELECT CONSTRAINT_NAME as constraint_name'
      + ' FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE'
      + ' WHERE (REFERENCED_TABLE_NAME = ' + wrapSingleQuote(tableName)
      + ' AND REFERENCED_COLUMN_NAME = ' + wrapSingleQuote(columnName)
      + ') OR (TABLE_NAME = ' + wrapSingleQuote(tableName)
      + ' AND COLUMN_NAME = ' + wrapSingleQuote(columnName)
      + ' AND REFERENCED_TABLE_NAME IS NOT NULL'
      + ')';
  },

  /**
   * Generates an SQL query that removes a foreign key from a table.
   *
   * @param  {String} tableName  The name of the table.
   * @param  {String} foreignKey The name of the foreign key constraint.
   * @return {String}            The generated sql query.
   * @private
   */
  dropForeignKeyQuery(tableName, foreignKey) {
    return 'ALTER TABLE ' + this.quoteTable(tableName) + ' DROP FOREIGN KEY ' + this.quoteIdentifier(foreignKey) + ';';
  }
};

// private methods
function wrapSingleQuote(identifier) {
  return Utils.addTicks(identifier, '\'');
}

module.exports = QueryGenerator;
