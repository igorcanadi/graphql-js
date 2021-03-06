/* @flow */
/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import * as Kind from '../language/kinds';
import type { Field } from '../language/ast';
import {
  isCompositeType,
  getNullableType,
  getNamedType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  GraphQLInputObjectType,
  GraphQLList,
} from '../type/definition';
import type {
  GraphQLType,
  GraphQLInputType,
  GraphQLOutputType,
  GraphQLCompositeType,
  GraphQLFieldDefinition,
  GraphQLArgument
} from '../type/definition';
import type { GraphQLDirective } from '../type/directives';
import {
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef
} from '../type/introspection';
import type { GraphQLSchema } from '../type/schema';
import type { Node } from '../language/ast';
import { typeFromAST } from './typeFromAST';
import find from '../jsutils/find';


/**
 * TypeInfo is a utility class which, given a GraphQL schema, can keep track
 * of the current field and type definitions at any point in a GraphQL document
 * AST during a recursive descent by calling `enter(node)` and `leave(node)`.
 */
export class TypeInfo {
  _schema: GraphQLSchema;
  _typeStack: Array<?GraphQLOutputType>;
  _parentTypeStack: Array<?GraphQLCompositeType>;
  _inputTypeStack: Array<?GraphQLInputType>;
  _fieldDefStack: Array<?GraphQLFieldDefinition>;
  _directive: ?GraphQLDirective;
  _argument: ?GraphQLArgument;
  _getFieldDef: typeof getFieldDef;

  constructor(
    schema: GraphQLSchema,
    // NOTE: this experimental optional second parameter is only needed in order
    // to support non-spec-compliant codebases. You should never need to use it.
    // It may disappear in the future.
    getFieldDefFn?: typeof getFieldDef
  ) {
    this._schema = schema;
    this._typeStack = [];
    this._parentTypeStack = [];
    this._inputTypeStack = [];
    this._fieldDefStack = [];
    this._directive = null;
    this._argument = null;
    this._getFieldDef = getFieldDefFn || getFieldDef;
  }

  getType(): ?GraphQLOutputType {
    if (this._typeStack.length > 0) {
      return this._typeStack[this._typeStack.length - 1];
    }
  }

  getParentType(): ?GraphQLCompositeType {
    if (this._parentTypeStack.length > 0) {
      return this._parentTypeStack[this._parentTypeStack.length - 1];
    }
  }

  getInputType(): ?GraphQLInputType {
    if (this._inputTypeStack.length > 0) {
      return this._inputTypeStack[this._inputTypeStack.length - 1];
    }
  }

  getFieldDef(): ?GraphQLFieldDefinition {
    if (this._fieldDefStack.length > 0) {
      return this._fieldDefStack[this._fieldDefStack.length - 1];
    }
  }

  getDirective(): ?GraphQLDirective {
    return this._directive;
  }

  getArgument(): ?GraphQLArgument {
    return this._argument;
  }

  // Flow does not yet handle this case.
  enter(node: any/* Node */) {
    var schema = this._schema;
    switch (node.kind) {
      case Kind.SELECTION_SET:
        var namedType = getNamedType(this.getType());
        var compositeType: ?GraphQLCompositeType;
        if (isCompositeType(namedType)) {
          // isCompositeType is a type refining predicate, so this is safe.
          compositeType = ((namedType: any): GraphQLCompositeType);
        }
        this._parentTypeStack.push(compositeType);
        break;
      case Kind.FIELD:
        var parentType = this.getParentType();
        var fieldDef;
        if (parentType) {
          fieldDef = this._getFieldDef(schema, parentType, node);
        }
        this._fieldDefStack.push(fieldDef);
        this._typeStack.push(fieldDef && fieldDef.type);
        break;
      case Kind.DIRECTIVE:
        this._directive = schema.getDirective(node.name.value);
        break;
      case Kind.OPERATION_DEFINITION:
        let type;
        if (node.operation === 'query') {
          type = schema.getQueryType();
        } else if (node.operation === 'mutation') {
          type = schema.getMutationType();
        } else if (node.operation === 'subscription') {
          type = schema.getSubscriptionType();
        }
        this._typeStack.push(type);
        break;
      case Kind.INLINE_FRAGMENT:
      case Kind.FRAGMENT_DEFINITION:
        var typeConditionAST = node.typeCondition;
        let outputType = typeConditionAST ?
          typeFromAST(schema, typeConditionAST) :
          this.getType();
        this._typeStack.push(((outputType: any): GraphQLOutputType));
        break;
      case Kind.VARIABLE_DEFINITION:
        let inputType = typeFromAST(schema, node.type);
        this._inputTypeStack.push(((inputType: any): GraphQLInputType));
        break;
      case Kind.ARGUMENT:
        var argDef;
        var argType;
        var fieldOrDirective = this.getDirective() || this.getFieldDef();
        if (fieldOrDirective) {
          argDef = find(
            fieldOrDirective.args,
            arg => arg.name === node.name.value
          );
          if (argDef) {
            argType = argDef.type;
          }
        }
        this._argument = argDef;
        this._inputTypeStack.push(argType);
        break;
      case Kind.LIST:
        var listType = getNullableType(this.getInputType());
        this._inputTypeStack.push(
          listType instanceof GraphQLList ?
            ((listType.ofType: any): GraphQLInputType) :
            undefined
        );
        break;
      case Kind.OBJECT_FIELD:
        var objectType = getNamedType(this.getInputType());
        var fieldType;
        if (objectType instanceof GraphQLInputObjectType) {
          var inputField = objectType.getFields()[node.name.value];
          fieldType = inputField ? inputField.type : undefined;
        }
        this._inputTypeStack.push(fieldType);
        break;
    }
  }

  leave(node: Node) {
    switch (node.kind) {
      case Kind.SELECTION_SET:
        this._parentTypeStack.pop();
        break;
      case Kind.FIELD:
        this._fieldDefStack.pop();
        this._typeStack.pop();
        break;
      case Kind.DIRECTIVE:
        this._directive = null;
        break;
      case Kind.OPERATION_DEFINITION:
      case Kind.INLINE_FRAGMENT:
      case Kind.FRAGMENT_DEFINITION:
        this._typeStack.pop();
        break;
      case Kind.VARIABLE_DEFINITION:
        this._inputTypeStack.pop();
        break;
      case Kind.ARGUMENT:
        this._argument = null;
        this._inputTypeStack.pop();
        break;
      case Kind.LIST:
      case Kind.OBJECT_FIELD:
        this._inputTypeStack.pop();
        break;
    }
  }
}

/**
 * Not exactly the same as the executor's definition of getFieldDef, in this
 * statically evaluated environment we do not always have an Object type,
 * and need to handle Interface and Union types.
 */
function getFieldDef(
  schema: GraphQLSchema,
  parentType: GraphQLType,
  fieldAST: Field
): ?GraphQLFieldDefinition {
  var name = fieldAST.name.value;
  if (name === SchemaMetaFieldDef.name &&
      schema.getQueryType() === parentType) {
    return SchemaMetaFieldDef;
  }
  if (name === TypeMetaFieldDef.name &&
      schema.getQueryType() === parentType) {
    return TypeMetaFieldDef;
  }
  if (name === TypeNameMetaFieldDef.name &&
      (parentType instanceof GraphQLObjectType ||
       parentType instanceof GraphQLInterfaceType ||
       parentType instanceof GraphQLUnionType)
  ) {
    return TypeNameMetaFieldDef;
  }
  if (parentType instanceof GraphQLObjectType ||
      parentType instanceof GraphQLInterfaceType) {
    return parentType.getFields()[name];
  }
}
