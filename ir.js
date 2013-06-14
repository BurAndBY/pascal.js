/*
 * Based on https://raw.github.com/zaach/floop.js/master/lib/lljsgen.js @ 4a981a2799
 */

var util = require('util'),
    ieee754 = require('./ieee754');

function id(identifier) {
  return identifier.split('-').join('_').replace('?', '$');
}

function SymbolTable() {
  var data = [{}];

  function begin_scope() {
    data.push({});
  }
  function end_scope() {
    if (data.length === 1) {
      throw new Error("end_scope without begin_scope");
    }
    data.pop();
  }

  function indexOf(name) {
    for(var idx = data.length-1; idx >= 0; idx--) {
      if (data[idx][name]) {
        return idx;
      }
    }
    return undefined;
  }

  function lookup(name) {
    var name = name.toUpperCase(),
        idx = indexOf(name);
    if (typeof(idx) !== "undefined") {
      return data[idx][name];
    }
    throw new Error("Name '" + name + "' not found in symbol table");
  }

  function insert(name, value, level) {
    if (typeof level === 'undefined') { level = data.length-1; }
    data[level][name.toUpperCase()] = value;
  }

  function replace(name, value) {
    var name = name.toUpperCase(),
        idx = indexOf(name);
    if (typeof(idx) !== "undefined") {
      data[idx][name] = value;
    } else {
      throw new Error("Name '" + name + "' not found to replace");
    }
  }

  function display() {
    console.warn("-------------");
    for(var idx = 0; idx < data.length; idx++) {
      console.warn("--- " + idx + " ---");
      for(var name in data[idx]) {
        console.warn(name + ": ", data[idx][name]);
      }
    }
    console.warn("-------------");
  }

  return {lookup: lookup,
          insert: insert,
          replace: replace,
          begin_scope: begin_scope,
          end_scope: end_scope,
          display: display};
};

function IR(theAST) {

  var st = new SymbolTable();
  var vcnt = 0; // variable counter
  var str_cnt = 0;
  var name_cnt = 0;
  var expected_returned_type = 'NoTyp';

  function new_name(name) {
    return name + "_" + (name_cnt++) + "_";
  }

  function expand_type(type) {
    var t = type;
    while (t.name === 'NAMED') {
      var tdecl = st.lookup(t.id);
      t = tdecl.type;
    }
    return t;
  }

  // Resolve a type definition to add lltype containing LLVM type
  // string. If the type is a named type then it will be resolved to
  // a base type first.
  function annotate_type(type) {
    var t = expand_type(type);
    switch (t.name) {
      case 'INTEGER': t.lltype = "i32"; break;
      case 'REAL':    t.lltype = "float"; break;
      case 'BOOLEAN': t.lltype = "i1"; break;
      case 'STRING':  t.lltype = "i8*"; break;
      case 'ARRAY':
        var index = t.index,
            start = index.start,
            end = index.end;
        t.lltype = '[' + (end-start+1) + ' x ' + annotate_type(t.type).lltype + ']';
        break;
      case 'RECORD':
        var comps = [],
            sections = t.sections;
        t.component_map = {};
        for (var i=0; i<sections.length; i++) {
          var comp = sections[i];
          comps.push(annotate_type(comp.type).lltype);
          t.component_map[comp.id] = i;
        }
        t.lltype = "{" + comps.join(", ") + "}";
        break;
      default: throw new Error("TODO: handle " + t.name + " type");
    }
    // Copy up the type data
    type.name = t.name;
    var keys = ['type', 'lltype', 'index', 'sections', 'component_map'];
    for (var i=0; i < keys.length; i++) {
      var k = keys[i];
      if (typeof t[k] !== 'undefined' && typeof type[k] === 'undefined') {
          type[k] = t[k];
      }
    }
    return type;
  }

  function isScalar(type) {
    var t = expand_type(type);
    var res = false;
    switch (t.name) {
      case 'INTEGER': res = true; break;
      case 'REAL':    res = true; break;
      case 'BOOLEAN': res = true; break;
    }
    return res;
  }

  function isString(type) {
    var t = expand_type(type);
    return (t.name === 'STRING');
  }

  function isScalarOrString(type) {
    return (isScalar(type) || isString(type));
  }

  function deref_name(lvalue) {
    var id = null,
        lv = lvalue,
        cnames = "";
    do {
      if (lv.node === 'expr_record_deref') {
        cnames = "." + lv.component + cnames ;
      } else if (lv.node === 'expr_array_deref') {
        cnames = "_sub" + cnames;
      } else {
        cnames = lv.id + cnames;
      }
      lv = lv.lvalue;
    } while (lv);
    return cnames;
  }


  // normalizeIR takes a JSON IR
  function normalizeIR(ir) {
    var prefix = [], body = [];
    body.push("");
    for (var i=0; i < ir.length; i++) {
      if (typeof(ir[i]) === "object") {
        prefix.push.apply(prefix, ir[i]);
      } else {
        body.push(ir[i]);
      }
    }
    return (prefix.concat(body)).join("\n");
  }

  function toIR(astTree, level, fnames) {
    var ast = (typeof astTree === 'undefined') ? theAST : astTree,
        indent = "",
        fname, node,
        ir = [];
    if (! ast) {
      throw new Error("Warning: toIR called with empty/null AST");
    }
    node = ast.node,
    level = level ? level : 0;
    fnames = fnames ? fnames : ['main'];
    fname = fnames[fnames.length-1];
    for (var i=0; i < level; i++) {
      indent = indent + "  ";
    }

    //console.warn("toIR",node,"level:", level, "fnames:", fnames, "ast:", JSON.stringify(ast));

    switch (node) {
      case 'program':
        var name = ast.id,  // TODO: do anything with program name?
            fparams = ast.fparams,
            block = ast.block;
        st.insert('main',{name:'main',level:level,fparams:fparams,lparams:[]});

        ir.push("declare i32 @printf(i8*, ...)");
        ir.push("");
        ir.push('@.newline = private constant [2 x i8] c"\\0A\\00"');
        ir.push('@.true_str = private constant [5 x i8] c"TRUE\\00"');
        ir.push('@.false_str = private constant [6 x i8] c"FALSE\\00"');
        ir.push('@.str_format = private constant [3 x i8] c"%s\\00"');
        ir.push('@.int_format = private constant [3 x i8] c"%d\\00"');
        ir.push('@.float_format = private constant [4 x i8] c"% E\\00"');
        ir.push('');
        block.param_list = [];
        ir.push.apply(ir, toIR(block,level,fnames));
        break;

      case 'block':
        var decls = ast.decls,
            stmts = ast.stmts,
            pdecl = st.lookup(fname),
            lparams = pdecl.lparams,
            fparams = pdecl.fparams,
            param_list = [],
            lparam_list = [],
            pdecl_ir = [],
            vdecl_ir = [],
            stmts_ir = [];

        // Regular formal parameters
        for (var i=0; i < fparams.length; i++) {
          var fparam = fparams[i],
              ftype = annotate_type(fparam.type),
              lltype = ftype.lltype,
              pname = "%" + new_name(fparam.id + "_fparam"),
              sname = "%" + new_name(fparam.id + "_fparam_stack");
          if (fparam.var) {
            vdecl_ir.push('  ' + pname + ' = load ' + lltype + '* ' + sname);
            param_list.push(lltype + '* ' + sname);
          } else {
            vdecl_ir.push('  ' + sname + ' = alloca ' + lltype);
            vdecl_ir.push('  store ' + lltype + ' ' + pname + ', ' + lltype + '* ' + sname);
            param_list.push(lltype + ' ' + pname);
          }
          st.insert(fparam.id,{node:'var_decl',type:ftype,pname:pname,sname:sname,var:fparam.var,level:level});
        }
        // Evaluate the children. We might need to modify the
        // param-list based on internal variables that refer to higher
        // level lexical scope
        for (var i=0; i < decls.length; i++) {
          var decl = decls[i];
          if (decl.node === 'proc_decl' || decl.node === 'func_decl') {
            pdecl_ir.push.apply(pdecl_ir, toIR(decl,level,fnames));
          } else {
            vdecl_ir.push.apply(vdecl_ir, toIR(decl,level,fnames));
          }
        }
        for (var i=0; i < stmts.length; i++) {
          stmts_ir.push.apply(stmts_ir, toIR(stmts[i],level,fnames));
        }

        // Variables that refer to higher lexical scope
        for (var i=0; i < lparams.length; i++) {
          var lparam = lparams[i],
              ldecl = st.lookup(lparam.id),
              sname = ldecl.sname,
              ltype = annotate_type(ldecl.type),
              lltype = ltype.lltype;
            lparam_list.push(lltype + '* ' + sname);
        }
        param_list = lparam_list.concat(param_list);

        // Now output the IR
        // Add sub-program declarations at the top level
        var pitype = pdecl.itype || "i32";
        ir.push.apply(ir, pdecl_ir);
        ir.push('');
        ir.push('define ' + pitype + ' @' + pdecl.name + '(' + param_list.join(", ") +') {');
        ir.push('entry:');
        // For functions, add the return parameter
        if (pdecl.ireturn) {
          ir.push('  %retval = alloca ' + pitype);
        }
        // Add variable declarations inside the body definition
        ir.push.apply(ir, vdecl_ir);
        // Postpone variable declarations until inside the body
        ir.push.apply(ir, stmts_ir);
        if (pdecl.ireturn) {
          ir.push('  %retreg = load ' + pitype + '* %retval');
          ir.push('  ret ' + pitype + ' %retreg');
        } else {
          ir.push('  ret ' + pitype + ' 0');
        }
        ir.push('}');
        break;

      case 'type_decl':
        var id = ast.id,
            type = ast.type;
        if (type.name === 'NAMED') {
          st.lookup(type.id); // verify the reference type exists
        }
        st.insert(ast.id,{node:'type_decl',id:id,type:type});
        break;

      case 'var_decl':
        var id = ast.id,
            vtype = annotate_type(ast.type),
            pdecl = st.lookup(fname),
            sname = "%" + new_name(id + "_stack");

        st.insert(id,{node:'var_decl',type:vtype,sname:sname,level:pdecl.level});
        ir.push('  ' + sname + ' = alloca ' + vtype.lltype);
        break;

      case 'proc_decl':
      case 'func_decl':
        var id = ast.id,
            type = ast.type,
            fparams = ast.fparams,
            block = ast.block,
            new_fname = new_name(id),
            new_level = level+1;

        st.insert(id, {name: new_fname, type:type, level: new_level,fparams:fparams,lparams:[]});
        st.begin_scope();
        ir.push.apply(ir, toIR(block,new_level,fnames.concat([id])));
        st.end_scope();
        break;

      case 'stmt_assign':
        var lvalue = ast.lvalue,
            expr = ast.expr
            lltype = null;
        ir.push('  ; ASSIGN start');
        ir.push.apply(ir,toIR(expr,level,fnames));
        if (lvalue.id === fname) {
          // This is actually a function name being used to set the
          // return value for the function so we don't evaluate the
          // lvalue
          var pdecl = st.lookup(fname);
          lvalue.type = pdecl.type;
          ptype = annotate_type(pdecl.type),
          lvalue.itype = ptype.lltype,
          pdecl.ireturn = true;
          pdecl.itype = lvalue.itype;
          ir.push('  store ' + expr.itype + ' ' + expr.ilocal + ', ' + pdecl.itype + '* %retval');
          st.replace(fname,pdecl);
        } else {
          ir.push.apply(ir,toIR(lvalue,level,fnames));
          if (expr.type.name === 'STRING' && expr.val) {
            // string literal being assigned so coerce
            var decay = '%' + new_name('arraydecay');
            ir.push('  ' + decay + ' = getelementptr inbounds ' + expr.itype + ' ' + expr.istack + ', i32 0, i32 0');
            ir.push('  store i8* ' + decay + ', ' + lvalue.itype + '* ' + lvalue.istack);
          } else {
            ir.push('  store ' + expr.itype + ' ' + expr.ilocal + ', ' + lvalue.itype + '* ' + lvalue.istack);
          }
        }
        
        if (lvalue.type.name !== expr.type.name) {
          throw new Error("Type of lvalue and expression do not match: " + lvalue.type.name + " vs " + expr.type.name);
        }

        ast.itype = lvalue.itype;
        ast.istack = lvalue.istack;
        ast.ilocal = expr.ilocal;
        ir.push('  ; ASSIGN finish');
        break;

      case 'stmt_call':
      case 'expr_call':
        var id = ast.id,
            cparams = (ast.call_params || []);
        // evaluate the parameters
        for(var i=0; i < cparams.length; i++) {
          var cparam = cparams[i];
          // TODO: make sure call params and formal params match
          // length and types
          ir.push.apply(ir, toIR(cparam,level,fnames));
        }
        // TODO: perhaps move to a separate library.js
        switch (id) {
          case 'WRITE':
          case 'WRITELN':
            ir.push('  ; WRITELN start');
            for(var i=0; i < cparams.length; i++) {
              var param = cparams[i],
                  v = vcnt++,
                  format = null,
                  flen = 3;
              switch (param.type.name) {
                case 'INTEGER': format = "@.int_format"; break;
                case 'REAL':
                  var conv = new_name('%conv');
                  ir.push('  ' + conv + ' = fpext float ' + param.ilocal + ' to double');
                  format = "@.float_format";
                  flen = 4;
                  param.itype = "double";
                  param.ilocal = conv;
                  break;
                case 'STRING':  format = "@.str_format"; break;
                case 'BOOLEAN':
                  var br_name = new_name('br'),
                      br_true = br_name + '_true',
                      br_false = br_name + '_false',
                      br_done = br_name + '_done',
                      bool_local1 = '%' + new_name('bool_local'),
                      bool_local2 = '%' + new_name('bool_local'),
                      bool_local_out = '%' + new_name('bool_local');
                  ir.push('  br ' + param.itype + ' ' + param.ilocal + ', label %' + br_true + ', label %' + br_false);
                  ir.push('  ' + br_true + ':');
                  ir.push('    ' + bool_local1 + ' = getelementptr [5 x i8]* @.true_str, i32 0, i32 0'); 
                  ir.push('  br label %' + br_done); 
                  ir.push('  ' + br_false + ':');
                  ir.push('    ' + bool_local2 + ' = getelementptr [6 x i8]* @.false_str, i32 0, i32 0'); 
                  ir.push('  br label %' + br_done); 
                  ir.push('  ' + br_done + ':');
                  ir.push('  ' + bool_local_out + ' = phi i8* [ ' + bool_local1 + ', %' + br_true + '], [ ' + bool_local2 + ', %' + br_false + ']');
                  format = "@.str_format";
                  param.itype = 'i8*';
                  param.ilocal = bool_local_out;
                  break;
                default:
                  throw new Error("Unknown WRITE type: " + param.type.name);
              }
              ir.push('  %str' + v + ' = getelementptr inbounds [' + flen + ' x i8]* ' + format + ', i32 0, i32 0');
              ir.push('  %call' + v + ' = call i32 (i8*, ...)* @printf(i8* %str' + v + ', ' +
                      param.itype + ' ' + param.ilocal + ')');
            }
            
            if (id === 'WRITELN') {
              v = vcnt++;
              ir.push('  %str' + v + ' = getelementptr inbounds [2 x i8]* @.newline, i32 0, i32 0');
              ir.push('  %call' + v + ' = call i32 (i8*, ...)* @printf(i8* %str' + v + ')');
            }
            ir.push('  ; WRITELN finish');
            break;
          default:
            var pdecl = st.lookup(id);
            if (!pdecl) {
              throw new Error("Unknown function '" + id + "'");
            }
            var lparams = pdecl.lparams,
                fparams = pdecl.fparams,
                param_list = [];
            for(var i=0; i < lparams.length; i++) {
              var lparam = lparams[i],
                  lltype = null;
              ir.push.apply(ir, toIR(lparam,level,fnames));
              ltype = annotate_type(lparam.type),
              param_list.push(ltype.lltype + "* " + lparam.istack);
            }
            for(var i=0; i < cparams.length; i++) {
              var cparam = cparams[i];
              if (cparams[i].lparam) {
                throw new Error("TODO handle lparam in call");
              } else if (fparams[i].var) {
                param_list.push(cparam.itype + "* " + cparam.istack);
              } else {
                param_list.push(cparam.itype + " " + cparam.ilocal);
              }
            }
            if (node === 'expr_call') {
              var ret = '%' + new_name(pdecl.name + "_ret"),
                ptype = annotate_type(pdecl.type),
                lltype = ptype.lltype;
              ir.push('  ' + ret + ' = call ' + lltype + ' @' + pdecl.name + "(" + param_list.join(", ") + ")");
              ast.type = pdecl.type;
              ast.itype = lltype;
              ast.ilocal = ret;
            } else {
              ir.push('  call i32 @' + pdecl.name + "(" + param_list.join(", ") + ")");
            }
        }
        break;

      case 'stmt_compound':
        for (var i=0; i < ast.stmts.length; i++) {
          ir.push.apply(ir,toIR(ast.stmts[i],level,fnames));
        }
        break;

      case 'stmt_if':
        var expr = ast.expr,
            tstmt = ast.tstmt,
            fstmt = ast.fstmt;
        ir.push('');
        ir.push('  ; if statement start');
        ir.push.apply(ir, toIR(expr,level,fnames));
        var br_name = new_name('br'),
            br_true = br_name + '_true',
            br_false = br_name + '_false',
            br_done = br_name + '_done';
        ir.push('  br ' + expr.itype + ' ' + expr.ilocal + ', label %' + br_true + ', label %' + br_false);
        ir.push('  ' + br_true + ':');
        if (tstmt) {
          ir.push.apply(ir, toIR(tstmt,level,fnames));
        }
        ir.push('  br label %' + br_done); 
        ir.push('  ' + br_false + ':');
        if (fstmt) {
          ir.push.apply(ir, toIR(fstmt,level,fnames));
        }
        ir.push('  br label %' + br_done); 
        ir.push('  ' + br_done + ':');
        ir.push('  ; if statement finish');
        ir.push('');
        break;

      case 'stmt_for':
        var index = ast.index,
            start = ast.start,
            by = ast.by,
            end = ast.end,
            stmt = ast.stmt,
            for_label = new_name('for'),
            for_start = for_label + 'start',
            for_cond = for_label + 'cond',
            for_body = for_label + 'body',
            for_inc = for_label + 'inc',
            for_end = for_label + 'end',
            for_index = '%' + for_label + 'index',
            for_cmp = '%' + for_label + 'cmp',
            for_cmp1 = '%' + for_label + 'cmp1',
            for_cmp2 = '%' + for_label + 'cmp2',
            for_inc1 = '%' + for_label + 'inc1',
            for0 = '%' + for_label + '0',
            for1 = '%' + for_label + '1',
            for2 = '%' + for_label + '2',
            for3 = '%' + for_label + '3';

        ir.push('');
        ir.push('  ; for statement start');

        ir.push.apply(ir, toIR(index,level,fnames));
        ir.push.apply(ir, toIR(start,level,fnames));
        ir.push.apply(ir, toIR(end,level,fnames));

        if (by === 1) {
          ir.push('  ' + for_cmp + ' = icmp sgt i32 ' + start.ilocal + ', ' + end.ilocal);
        } else {
          ir.push('  ' + for_cmp + ' = icmp slt i32 ' + start.ilocal + ', ' + end.ilocal);
        }
        ir.push('  br i1 ' + for_cmp + ', label %' + for_end + ', label %' + for_start);

        ir.push('  br label %' + for_start); 

        ir.push('');
        ir.push('  ' + for_start + ':');
        ir.push('  store ' + start.itype + ' ' + start.ilocal + ', ' + index.itype + '* ' + index.istack);
        ir.push('  br label %' + for_cond); 

        ir.push('');
        ir.push('  ' + for_cond + ':');
        ir.push('  ' + for1 + ' = load i32* ' + index.istack);
        if (by === 1) {
          ir.push('  ' + for_cmp1 + ' = icmp sle i32 ' + for1 + ', ' + end.ilocal);
        } else {
          ir.push('  ' + for_cmp1 + ' = icmp sge i32 ' + for1 + ', ' + end.ilocal);
        }
        ir.push('  br i1 ' + for_cmp1 + ', label %' + for_body + ', label %' + for_end);

        ir.push('');
        ir.push('  ' + for_body + ':');
        ir.push.apply(ir, toIR(stmt,level,fnames));
        ir.push('  ' + for2 + ' = load i32* ' + index.istack);
        ir.push('  ' + for_cmp2 + ' = icmp eq i32 ' + for2 + ', ' + end.ilocal);
        ir.push('  br i1 ' + for_cmp2 + ', label %' + for_end + ', label %' + for_inc);

        ir.push('');
        ir.push('  ' + for_inc + ':');
        ir.push('  ' + for3 + ' = load i32* ' + index.istack);
        ir.push('  ' + for_inc1 + ' = add nsw i32 ' + for3 + ', ' + by);
        ir.push('  store i32 ' + for_inc1 + ', i32* ' + index.istack);
        ir.push('  br label %' + for_cond);

        ir.push('');
        ir.push('  ' + for_end + ':');

        ir.push('  ; for statement finish');
        ir.push('');
        break;

      case 'stmt_while':
        var expr = ast.expr,
            stmt = ast.stmt,
            while_label = new_name('while'),
            while_cond = while_label + 'cond',
            while_body = while_label + 'body',
            while_end = while_label + 'end',
            for_index = '%' + for_label + 'index',
            for_cmp = '%' + for_label + 'cmp',
            for_cmp1 = '%' + for_label + 'cmp1',
            for_cmp2 = '%' + for_label + 'cmp2',
            for_inc1 = '%' + for_label + 'inc1',
            for0 = '%' + for_label + '0',
            for1 = '%' + for_label + '1',
            for2 = '%' + for_label + '2',
            for3 = '%' + for_label + '3';

        ir.push('');
        ir.push('  ; while statement start');

        ir.push('  br label %' + while_cond); 

        ir.push('');
        ir.push('  ' + while_cond + ':');
        ir.push.apply(ir, toIR(expr,level,fnames));
        ir.push('  br i1 ' + expr.ilocal + ', label %' + while_body + ', label %' + while_end);

        ir.push('');
        ir.push('  ' + while_body + ':');
        ir.push.apply(ir, toIR(stmt,level,fnames));
        ir.push('  br label %' + while_cond);

        ir.push('');
        ir.push('  ' + while_end + ':');

        ir.push('  ; while statement finish');
        ir.push('');
        break;

      case 'expr_binop':
        var left = ast.left, ltype,
            right = ast.right, rtype,
            resType = null, op,
            dest_name = '%' + new_name("binop"),
            boolLookup = {gt:'sgt',lt:'slt',
                          geq:'sge',leq:'sle',
                          eq:'eq',neq:'ne'},
            intLookup = {plus:'add',minus:'sub',
                         star:'mul',slash:'sdiv',
                         div:'sdiv',mod:'urem'},
            fltLookup = {plus:'fadd',minus:'fsub',
                         star:'fmul',slash:'fdiv'};
          
        ir.push.apply(ir, toIR(left,level,fnames));
        ir.push.apply(ir, toIR(right,level,fnames));
        ltype = annotate_type(left.type);
        rtype = annotate_type(right.type);
        if (ast.op in {gt:1,lt:1,geq:1,leq:1,eq:1,neq:1}) {
          var msgPrefix = "Operands for '" + ast.op + "' ";
          // Type-check
          if (ltype.name !== rtype.name) {
            throw new Error(msgPrefix + "are not the same type");
          }
          if (ast.op in {gt:1,lt:1}) {
            // scalar, string
            if (! (isScalarOrString(ltype) && isScalarOrString(rtype))) {
              throw new Error(msgPrefix + "are not scalar or string");
            }
          } else if (ast.op in {geq:1,leq:1}) {
            // scalar, string, set
            // TODO: sets
            if (! (isScalarOrString(ltype) && isScalarOrString(rtype))) {
              throw new Error(msgPrefix + "are not scalar or string");
            }
          } else if (ast.op in {eq:1,neq:1}) {
            // scalar, string, set or pointer types
            // TODO: sets and pointers
            if (! (isScalarOrString(ltype) && isScalarOrString(rtype))) {
              throw new Error(msgPrefix + "are not scalar or string");
            }
          }
          if (ltype.name === 'REAL') {
            op = 'ficmp ' + boolLookup[ast.op];
          } else {
            op = 'icmp ' + boolLookup[ast.op];
          }
          resType={node:'type',name:'BOOLEAN',lltype:'i1'};
        } else if (ast.op in {plus:1,minus:1,star:1,slash:1,div:1,mod:1}) {
          if (ast.op === 'slash') {
            resType = {node:'type',name:'REAL',lltype:"float"};
          } else if ((ltype.name === 'INTEGER' && rtype.name === 'INTEGER') ||
                     (ltype.name === 'REAL' && rtype.name === 'REAL')) {
            resType = ltype;
          } else if (ltype.name === 'REAL' && rtype.name === 'INTEGER') {
            resType = ltype;
          } else if (ltype.name === 'INTEGER' && rtype.name === 'REAL') {
            resType = rtype;
          } else {
            throw new Error("No defined behavior for " +
                            ltype.name + " " + ast.op + " " + rtype.name);
          }
          if (resType.name === 'REAL' && ast.op === 'div') {
            throw new Error("div can only be used with Integers");
          }
          if (resType.name === 'REAL') {
            op = fltLookup[ast.op];
          } else {
            op = intLookup[ast.op];
          }
        } else if (ast.op in {and:1,or:1}) {
          op = ast.op;
          resType = left.type;
        } else {
          throw new Error("Unexpected expr_binop operand " + ast.op);
        }
        if (resType.name === 'REAL' && ltype.name === 'INTEGER') {
          var conv = new_name("%conv");
          ir.push('  ' + conv + ' = sitofp i32 ' + left.ilocal + ' to float');
          left.ilocal = conv;
          left.itype = 'float';
        }
        if (resType.name === 'REAL' && rtype.name === 'INTEGER') {
          var conv = new_name("%conv");
          ir.push('  ' + conv + ' = sitofp i32 ' + right.ilocal + ' to float');
          right.ilocal = conv;
          right.itype = 'float';
        }
        ir.push('  ' + dest_name + ' = ' + op + ' ' + left.itype + ' ' + left.ilocal + ', ' + right.ilocal);
        ast.type = resType;
        ast.itype = resType.lltype;
        ast.ilocal = dest_name;
        break;

      case 'expr_unop':
        var expr = ast.expr,
            dest_name = '%' + new_name("unop"),
            op;
        ir.push.apply(ir, toIR(expr,level,fnames));
        // TODO: real typechecking comparison
        switch (ast.op) {
          case 'minus':
            ir.push('  ' + dest_name + ' = sub i32 0, ' + expr.ilocal);
            break;
          case 'not':
            ir.push('  ' + dest_name + ' = xor i1 1, ' + expr.ilocal);
            break;
          default: throw new Error("Unexpected expr_unop operand " + ast.op);
        }
        ast.type = expr.type;
        ast.itype = expr.itype;
        ast.ilocal = dest_name;
        break;

      case 'expr_array_deref':
        var lvalue = ast.lvalue,
            expr = ast.expr;
        ir.push.apply(ir, toIR(expr,level,fnames));
        ir.push.apply(ir, toIR(lvalue,level,fnames));

        var atype = lvalue.type,
            start = atype.index.start,
            aname = '%' + new_name(deref_name(ast)),
            aidx = aname + 'idx',
            aoff = aname + 'off',
            aval = aname + 'val';
        ir.push('  ' + aidx + ' = sub ' + expr.itype + ' ' + expr.ilocal + ', ' + start);
        ir.push('  ' + aoff + ' = getelementptr inbounds ' + atype.lltype + '* ' + lvalue.istack + ', i32 0, ' + expr.itype + ' ' + aidx);
        ir.push('  ' + aval + ' = load ' + atype.type.lltype + '* ' + aoff);
        ast.type = atype.type;
        ast.itype = atype.type.lltype;
        ast.istack = aoff;
        ast.ilocal = aval;
        break;

      case 'expr_record_deref':
        var lvalue = ast.lvalue,
            comp = ast.component;
        ir.push.apply(ir, toIR(lvalue,level,fnames));
        var cidx = lvalue.type.component_map[comp],
            ctype = lvalue.type.sections[cidx].type,
            clltype = ctype.lltype,
            rname = '%' + new_name(deref_name(ast)),
            roff = rname + '_off',
            rval = rname + '_val';
        ir.push('  ' + roff + ' = getelementptr inbounds ' + lvalue.itype + '* ' + lvalue.istack + ', i32 0, i32 ' + cidx);
        ir.push('  ' + rval + ' = load ' + clltype + '* ' + roff);
        ast.type = ctype;
        ast.itype = clltype;
        ast.istack = roff;
        ast.ilocal = rval;
        break;

      case 'integer':
        ast.itype = "i32";
        ast.ilocal = ast.val;
        break;
      case 'real':
        ast.itype = "float";
        ast.ilocal = ieee754.llvm_float_hex(ast.val);
        break;
      case 'string':
        var sval = ast.val,
            slen = sval.length+1,
            sname = '@.string' + (str_cnt++),
            lname;
        ir.push([sname + ' = private constant [' + slen + ' x i8] c"' + sval + '\\00"']);
        ast.itype = '[' + slen + ' x i8]*';
        ast.ilocal = sname;
        ast.istack = sname;
        ast.iref = sname;
        break;
      case 'boolean':
        ast.itype = "i1";
        ast.ilocal = ast.val.toString();
        break;

      case 'variable':
        var id = ast.id,
            vdecl = st.lookup(ast.id),
            vtype = annotate_type(vdecl.type),
            sname = vdecl.sname,
            vlevel = vdecl.level,
            lname = "%" + new_name(id + "_local");

        if (vdecl.fparams) {
          // This is actually a function call expression so
          // replace the AST with a function and evalutate it
          ast.node = 'expr_call';
          ast.call_params = [];
          ir.push.apply(ir, toIR(ast,level,fnames));
          break;
        }

        // Add on any variables from a higher lexical scope first
        if (level !== vlevel) {
          // Variable is in higher lexical scope, simulate static
          // link by passing the variable through intervening
          // sub-programs
          var new_pname, new_sname;
          for(var l = vlevel+1; l <= level; l++) {
            var fname = fnames[l],
                pdecl = st.lookup(fname);
            new_pname = "%" + new_name(id + "_lparam");
            new_sname = new_pname + "_stack";
            // replace vdecl and insert it at this level
            vdecl = {node:'var_decl',type:vtype,pname:new_pname,sname:new_sname,var:true,lparam:true,level:l};
            st.insert(id,vdecl,l);
            // add the variable to the lparams (lexical variables) 
            pdecl.lparams.push({node:'variable',id:id,type:vtype});
            st.replace(fname,pdecl);
          }
          ir.push('  ' + new_pname + ' = load ' + vtype.lltype + '* ' + new_sname + ' ; ' + l);
          ast.ilocal = new_pname;
          ast.istack = new_sname;
        }

        ast.type = vtype;
        ast.itype = vtype.lltype;
        ast.istack = vdecl.sname;
        ast.ilocal = lname;
        ir.push('  ' + ast.ilocal + ' = load ' + vtype.lltype + '* ' + ast.istack);
        break;

      default:
        throw new Error("Unknown AST: " + JSON.stringify(ast));
    }

    return ir;
  }

  return {toIR: toIR, normalizeIR: normalizeIR,
          displayST: function() { st.display(); },
          getAST: function() { return theAST; }};
}

exports.IR = IR;
exports.toIR = function (ast) {
  var ir = new IR(ast);
  return ir.normalizeIR(ir.toIR());
};
if (typeof module !== 'undefined' && require.main === module) {
  var ast = require('./parse').main(process.argv.slice(1));
  console.log(exports.toIR(ast));
}

// vim: expandtab:ts=2:sw=2:syntax=javascript
